import { API_ENDPOINTS } from "../config/api";
import {
  getCachedMaintenanceReports,
  listPendingMaintenanceReports,
  markMaintenanceReportSyncFailed,
  markMaintenanceReportSynced,
  markMaintenanceReportSyncing,
  saveMaintenanceReports,
} from "./offlineStore";

function makeOfflineResult(cached, error) {
  if (!cached?.payload) throw error;
  return {
    payload: cached.payload,
    online: false,
    syncedAt: cached.syncedAt || "",
    fromCache: true,
    message: "Showing offline data.",
  };
}

function appendFormValue(formData, key, value) {
  if (value === undefined || value === null) return;
  formData.append(key, String(value));
}

function getImageName(uri, index) {
  const raw = String(uri || "").split("/").pop() || `photo_${index + 1}.jpg`;
  return raw.includes(".") ? raw : `${raw}.jpg`;
}

function toFormData(payload) {
  const formData = new FormData();
  appendFormValue(formData, "event_time", payload.event_time);
  appendFormValue(formData, "lon", payload.lon);
  appendFormValue(formData, "lat", payload.lat);
  appendFormValue(formData, "address", payload.address);
  appendFormValue(formData, "municipality", payload.municipality);
  appendFormValue(formData, "barangay", payload.barangay);
  appendFormValue(formData, "feeder", payload.feeder);
  appendFormValue(formData, "project_code", payload.project_code);
  appendFormValue(formData, "report_type", payload.report_type);
  appendFormValue(formData, "report_desc", payload.report_desc);
  appendFormValue(formData, "landmark", payload.landmark);
  appendFormValue(formData, "findings", payload.findings);
  appendFormValue(formData, "recommendations", payload.recommendations);
  appendFormValue(formData, "remarks", payload.remarks);
  appendFormValue(formData, "label", payload.label);
  appendFormValue(formData, "status", payload.status || "OPEN");
  appendFormValue(formData, "created_source", "mobile");
  appendFormValue(formData, "client_local_id", payload.client_local_id);
  appendFormValue(formData, "client_device_id", payload.client_device_id);
  appendFormValue(formData, "synced_at", new Date().toISOString());
  if (Array.isArray(payload.endorsed_to) && payload.endorsed_to.length > 0) {
    appendFormValue(formData, "endorsed_to", JSON.stringify(payload.endorsed_to));
    appendFormValue(formData, "endorsed_by", payload.endorsed_by);
    appendFormValue(formData, "visible_on", payload.visible_on);
  }
  if (Array.isArray(payload.images)) {
    payload.images.forEach((image, index) => {
      if (!image?.uri) return;
      formData.append("attachments", {
        uri: image.uri,
        name: image.fileName || getImageName(image.uri, index),
        type: image.mimeType || "image/jpeg",
      });
    });
  }
  return formData;
}

export async function loadMaintenanceReports({ token, preferCache = false } = {}) {
  const cached = await getCachedMaintenanceReports();
  if (preferCache && cached?.payload) {
    return {
      payload: cached.payload,
      online: false,
      syncedAt: cached.syncedAt || "",
      fromCache: true,
      message: "Showing offline data.",
    };
  }

  try {
    const response = await fetch(API_ENDPOINTS.maintenanceReports, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) throw new Error(data?.message || "Failed to load maintenance reports.");
    const syncedAt = await saveMaintenanceReports(data);
    return { payload: data, online: true, syncedAt, fromCache: false, message: "Synced." };
  } catch (error) {
    return makeOfflineResult(cached, error);
  }
}

export async function syncPendingMaintenanceReports({ token } = {}) {
  const pending = await listPendingMaintenanceReports();
  if (pending.length === 0) return { online: true, synced: 0, failed: 0 };

  let synced = 0;
  let failed = 0;
  let online = true;

  for (const item of pending) {
    try {
      await markMaintenanceReportSyncing(item.localId);
      const response = await fetch(API_ENDPOINTS.maintenanceReports, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: toFormData(item.payload),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok || !data?.id) {
        throw new Error(data?.message || "Failed to sync maintenance order.");
      }
      await markMaintenanceReportSynced(item.localId, data.id);
      synced += 1;
    } catch (error) {
      online = false;
      failed += 1;
      await markMaintenanceReportSyncFailed(item.localId, error?.message || "Unable to sync maintenance order.");
    }
  }

  return { online, synced, failed };
}

