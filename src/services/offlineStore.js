import * as SQLite from "expo-sqlite";

const DATABASE_NAME = "nes_field_app.db";
const CACHE_KEY_MAINTENANCE_REPORTS = "maintenance_reports";
const DEVICE_ID_KEY = "device_id";

let dbPromise;

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  const time = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}-${time}-${random}`;
}

async function getDb() {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync(DATABASE_NAME);
  }
  const db = await dbPromise;
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS cached_users (
      username TEXT PRIMARY KEY NOT NULL,
      token TEXT,
      user_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cache_entries (
      key TEXT PRIMARY KEY NOT NULL,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_maintenance_reports (
      local_id TEXT PRIMARY KEY NOT NULL,
      payload_json TEXT NOT NULL,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      server_mo_id INTEGER,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT
    );
    CREATE TABLE IF NOT EXISTS gis_layer_features (
      layer_key TEXT NOT NULL,
      feature_id TEXT NOT NULL,
      feature_json TEXT NOT NULL,
      min_lon REAL NOT NULL,
      min_lat REAL NOT NULL,
      max_lon REAL NOT NULL,
      max_lat REAL NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (layer_key, feature_id)
    );
    CREATE INDEX IF NOT EXISTS idx_gis_layer_features_bbox
      ON gis_layer_features (layer_key, min_lon, max_lon, min_lat, max_lat);
  `);
  return db;
}

export async function initOfflineStore() {
  await getDb();
}

export async function getDeviceId() {
  const db = await getDb();
  const row = await db.getFirstAsync("SELECT value FROM app_meta WHERE key = ?", DEVICE_ID_KEY);
  if (row?.value) return row.value;
  const deviceId = makeId("NES-MOB");
  await db.runAsync(
    `INSERT INTO app_meta (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    DEVICE_ID_KEY,
    deviceId
  );
  return deviceId;
}

export function createLocalMaintenanceId(deviceId) {
  const suffix = makeId("MO").replace("MO-", "");
  return `${deviceId}-${suffix}`;
}

export async function saveSession(session) {
  const username = String(session?.user?.username || "").trim().toLowerCase();
  if (!username) return;
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO cached_users (username, token, user_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET
       token = excluded.token,
       user_json = excluded.user_json,
       updated_at = excluded.updated_at`,
    username,
    session?.token || "",
    JSON.stringify(session?.user || {}),
    nowIso()
  );
}

export async function getCachedSession(username) {
  const normalized = String(username || "").trim().toLowerCase();
  if (!normalized) return null;
  const db = await getDb();
  const row = await db.getFirstAsync("SELECT token, user_json FROM cached_users WHERE username = ?", normalized);
  if (!row?.user_json) return null;
  try {
    return { token: row.token || "", user: JSON.parse(row.user_json) || {} };
  } catch {
    return null;
  }
}

export async function saveMaintenanceReports(payload) {
  const db = await getDb();
  const syncedAt = nowIso();
  await db.runAsync(
    `INSERT INTO cache_entries (key, json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       json = excluded.json,
       updated_at = excluded.updated_at`,
    CACHE_KEY_MAINTENANCE_REPORTS,
    JSON.stringify(payload || { type: "FeatureCollection", features: [] }),
    syncedAt
  );
  await db.runAsync(
    `INSERT INTO app_meta (key, value)
     VALUES ('last_synced_at', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    syncedAt
  );
  return syncedAt;
}

export async function getCachedMaintenanceReports() {
  const db = await getDb();
  const row = await db.getFirstAsync("SELECT json, updated_at FROM cache_entries WHERE key = ?", CACHE_KEY_MAINTENANCE_REPORTS);
  if (!row?.json) return null;
  try {
    return { payload: JSON.parse(row.json), syncedAt: row.updated_at || "" };
  } catch {
    return null;
  }
}

function visitCoordinates(coordinates, visitor) {
  if (!Array.isArray(coordinates)) return;
  if (typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
    visitor(Number(coordinates[0]), Number(coordinates[1]));
    return;
  }
  coordinates.forEach((entry) => visitCoordinates(entry, visitor));
}

function getFeatureBbox(feature) {
  const geometry = feature?.geometry;
  if (!geometry?.coordinates) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  visitCoordinates(geometry.coordinates, (lon, lat) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  });
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return null;
  return { minLon, minLat, maxLon, maxLat };
}

function getFeatureId(feature, index, layerKey = "") {
  const props = feature?.properties || {};
  const key = String(layerKey || "").trim().toLowerCase();
  if (feature?.id) return String(feature.id);
  if (props.id) return String(props.id);
  if (props.gid) return String(props.gid);
  if (props.objectid) return String(props.objectid);
  if (props.OBJECTID) return String(props.OBJECTID);
  if (key === "poles" && props.nodeid) return String(props.nodeid) + "_" + String(index);
  return String(
    props.nodeid
      || props.device_id
      || props.unique_device_id
      || `feature_${index}`
  );
}

export async function saveGisLayerFeatures(layerKey, featureCollection) {
  const key = String(layerKey || "").trim();
  const features = Array.isArray(featureCollection?.features) ? featureCollection.features : [];
  if (!key) return { saved: 0, received: features.length, syncedAt: "" };
  const db = await getDb();
  const syncedAt = nowIso();
  const batchSize = 1000;
  const insertSql = `INSERT OR REPLACE INTO gis_layer_features
    (layer_key, feature_id, feature_json, min_lon, min_lat, max_lon, max_lat, updated_at)
    VALUES ($layerKey, $featureId, $featureJson, $minLon, $minLat, $maxLon, $maxLat, $updatedAt)`;

  await db.runAsync("DELETE FROM gis_layer_features WHERE layer_key = ?", key);
  let saved = 0;
  for (let start = 0; start < features.length; start += batchSize) {
    const batch = features.slice(start, start + batchSize);
    await db.withTransactionAsync(async () => {
      const statement = await db.prepareAsync(insertSql);
      try {
        for (let offset = 0; offset < batch.length; offset += 1) {
          const index = start + offset;
          const feature = batch[offset];
          const bbox = getFeatureBbox(feature);
          if (!bbox) continue;
          await statement.executeAsync({
            $layerKey: key,
            $featureId: getFeatureId(feature, index, key),
            $featureJson: JSON.stringify(feature),
            $minLon: bbox.minLon,
            $minLat: bbox.minLat,
            $maxLon: bbox.maxLon,
            $maxLat: bbox.maxLat,
            $updatedAt: syncedAt,
          });
          saved += 1;
        }
      } finally {
        await statement.finalizeAsync();
      }
    });
  }
  await db.runAsync(
    `INSERT INTO app_meta (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    `last_gis_layer_${key}_synced_at`,
    syncedAt
  );
  const countRow = await db.getFirstAsync("SELECT COUNT(*) AS count FROM gis_layer_features WHERE layer_key = ?", key);
  return { saved: Number(countRow?.count || saved), received: features.length, syncedAt };
}

export async function getGisLayerCacheStats(layerKeys = []) {
  const db = await getDb();
  const keys = Array.isArray(layerKeys) && layerKeys.length ? layerKeys : [
    "primarylines",
    "poles",
    "secondarylines",
    "transformers",
    "fco",
    "recloser",
    "ds",
    "lbs",
  ];
  const stats = {};
  for (const key of keys) {
    const row = await db.getFirstAsync(
      "SELECT COUNT(*) AS count, MAX(updated_at) AS updated_at FROM gis_layer_features WHERE layer_key = ?",
      key
    );
    stats[key] = { count: Number(row?.count || 0), updatedAt: row?.updated_at || "" };
  }
  return stats;
}

export async function saveGisLayers(payload) {
  const layers = payload?.layers || payload || {};
  const results = {};
  for (const [layerKey, featureCollection] of Object.entries(layers)) {
    results[layerKey] = await saveGisLayerFeatures(layerKey, featureCollection);
  }
  return results;
}

export async function getCachedGisLayersForCenter(center, radiusDegrees = 0.04, layerKeys = []) {
  const db = await getDb();
  const latitude = Number(center?.latitude);
  const longitude = Number(center?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { layers: {} };
  const minLon = longitude - radiusDegrees;
  const maxLon = longitude + radiusDegrees;
  const minLat = latitude - radiusDegrees;
  const maxLat = latitude + radiusDegrees;
  const keys = Array.isArray(layerKeys) && layerKeys.length ? layerKeys : [
    "primarylines",
    "poles",
    "secondarylines",
    "transformers",
    "fco",
    "recloser",
    "ds",
    "lbs",
  ];
  const layers = {};
  for (const key of keys) {
    const rows = await db.getAllAsync(
      `SELECT feature_json FROM gis_layer_features
       WHERE layer_key = ?
         AND max_lon >= ?
         AND min_lon <= ?
         AND max_lat >= ?
         AND min_lat <= ?`,
      key,
      minLon,
      maxLon,
      minLat,
      maxLat
    );
    const features = [];
    rows.forEach((row) => {
      try {
        features.push(JSON.parse(row.feature_json));
      } catch {
        // Ignore malformed cached features.
      }
    });
    layers[key] = { type: "FeatureCollection", features };
  }
  return { layers };
}

export async function getCachedGisLayersForBbox(bounds, layerKeys = []) {
  const db = await getDb();
  const minLon = Number(bounds?.minLon);
  const minLat = Number(bounds?.minLat);
  const maxLon = Number(bounds?.maxLon);
  const maxLat = Number(bounds?.maxLat);
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return { layers: {} };
  const rawMinLon = Math.min(minLon, maxLon);
  const rawMaxLon = Math.max(minLon, maxLon);
  const rawMinLat = Math.min(minLat, maxLat);
  const rawMaxLat = Math.max(minLat, maxLat);
  const lonSpan = Math.max(rawMaxLon - rawMinLon, 0.002);
  const latSpan = Math.max(rawMaxLat - rawMinLat, 0.002);
  const paddingLon = Math.max(lonSpan * 0.75, 0.006);
  const paddingLat = Math.max(latSpan * 0.75, 0.006);
  const queryMinLon = rawMinLon - paddingLon;
  const queryMaxLon = rawMaxLon + paddingLon;
  const queryMinLat = rawMinLat - paddingLat;
  const queryMaxLat = rawMaxLat + paddingLat;
  const keys = Array.isArray(layerKeys) && layerKeys.length ? layerKeys : [
    "primarylines",
    "poles",
    "secondarylines",
    "transformers",
    "fco",
    "recloser",
    "ds",
    "lbs",
  ];
  const layers = {};
  for (const key of keys) {
    const rows = await db.getAllAsync(
      `SELECT feature_json FROM gis_layer_features
       WHERE layer_key = ?
         AND max_lon >= ?
         AND min_lon <= ?
         AND max_lat >= ?
         AND min_lat <= ?`,
      key,
      queryMinLon,
      queryMaxLon,
      queryMinLat,
      queryMaxLat
    );
    const features = [];
    rows.forEach((row) => {
      try {
        features.push(JSON.parse(row.feature_json));
      } catch {
        // Ignore malformed cached features.
      }
    });
    layers[key] = { type: "FeatureCollection", features };
  }
  return { layers };
}

export async function getCachedGisLayers() {
  return getCachedGisLayersForCenter({ latitude: 16.4023, longitude: 120.5960 }, 0.04);
}
export async function getSyncMeta() {
  const db = await getDb();
  const row = await db.getFirstAsync("SELECT value FROM app_meta WHERE key = 'last_synced_at'");
  return { syncedAt: row?.value || "" };
}

export async function savePendingMaintenanceReport(payload) {
  const db = await getDb();
  const createdAt = payload?.created_at || nowIso();
  const localId = payload?.client_local_id || makeId("MO-LOCAL");
  const nextPayload = { ...payload, client_local_id: localId, created_at: createdAt };
  await db.runAsync(
    `INSERT INTO pending_maintenance_reports (local_id, payload_json, sync_status, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?)
     ON CONFLICT(local_id) DO UPDATE SET
       payload_json = excluded.payload_json,
       sync_status = 'pending',
       error_message = NULL,
       updated_at = excluded.updated_at`,
    localId,
    JSON.stringify(nextPayload),
    createdAt,
    nowIso()
  );
  return { localId, payload: nextPayload };
}

function parsePendingRow(row) {
  let payload = {};
  try {
    payload = JSON.parse(row.payload_json || "{}");
  } catch {
    payload = {};
  }
  return {
    localId: row.local_id,
    payload,
    syncStatus: row.sync_status,
    serverMoId: row.server_mo_id || null,
    errorMessage: row.error_message || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
    syncedAt: row.synced_at || "",
  };
}

export async function listPendingMaintenanceReports({ includeSynced = false } = {}) {
  const db = await getDb();
  const rows = await db.getAllAsync(
    includeSynced
      ? "SELECT * FROM pending_maintenance_reports ORDER BY created_at DESC"
      : "SELECT * FROM pending_maintenance_reports WHERE sync_status != 'synced' ORDER BY created_at DESC"
  );
  return rows.map(parsePendingRow);
}

export async function markMaintenanceReportSyncing(localId) {
  const db = await getDb();
  await db.runAsync(
    `UPDATE pending_maintenance_reports
     SET sync_status = 'syncing', error_message = NULL, updated_at = ?
     WHERE local_id = ?`,
    nowIso(),
    localId
  );
}

export async function markMaintenanceReportSynced(localId, serverMoId) {
  const db = await getDb();
  const syncedAt = nowIso();
  await db.runAsync(
    `UPDATE pending_maintenance_reports
     SET sync_status = 'synced', server_mo_id = ?, error_message = NULL, updated_at = ?, synced_at = ?
     WHERE local_id = ?`,
    Number(serverMoId) || null,
    syncedAt,
    syncedAt,
    localId
  );
}

export async function markMaintenanceReportSyncFailed(localId, message) {
  const db = await getDb();
  await db.runAsync(
    `UPDATE pending_maintenance_reports
     SET sync_status = 'failed', error_message = ?, updated_at = ?
     WHERE local_id = ?`,
    String(message || "Sync failed."),
    nowIso(),
    localId
  );
}

