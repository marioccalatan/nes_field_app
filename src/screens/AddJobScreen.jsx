import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { WebView } from "react-native-webview";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { API_ENDPOINTS } from "../config/api";
import { createLocalMaintenanceId, getCachedGisLayersForBbox, getCachedGisLayersForCenter, getDeviceId, getGisLayerCacheStats, listPendingMaintenanceReports, savePendingMaintenanceReport } from "../services/offlineStore";
import { loadMaintenanceReports, syncPendingMaintenanceReports, updateMaintenanceReport } from "../services/maintenanceReportsService";

const INITIAL_FORM = {
  reportType: "",
  reportDesc: "",
  address: "",
  municipality: "",
  barangay: "",
  feeder: "",
  lon: "",
  lat: "",
  remarks: "",
  visibleOn: "",
};

function clean(value) {
  return String(value || "").trim();
}

const FEEDER_COLORS = {
  FEEDER_01: "#FF6B6B",
  FEEDER_02: "#4D96FF",
  FEEDER_03: "#06D6A0",
  FEEDER_03A: "#FFD166",
  FEEDER_04: "#8338EC",
  FEEDER_05: "#EF476F",
  FEEDER_05A: "#118AB2",
  FEEDER_06: "#06A77D",
  FEEDER_07: "#8ECAE6",
  FEEDER_08: "#219EBC",
  FEEDER_09: "#023047",
  FEEDER_10: "#E76F51",
  FEEDER_11: "#2A9D8F",
  FEEDER_12: "#264653",
  FEEDER_14: "#2714fa",
  CIRCUIT_01: "#F72585",
  CIRCUIT_02: "#B5179E",
  CIRCUIT_03: "#7209B7",
  CIRCUIT_04: "#05f5ed",
  CIRCUIT_05: "#480CA8",
  CIRCUIT_06: "#f2a633",
  CIRCUIT_07: "#3F37C9",
  FEEDER_DALICNO: "#00B894",
  FEEDER_TAPSAN: "#D63031",
  FEEDER_LUELCO: "#6C5CE7",
};

const GIS_LAYER_DEFINITIONS = [
  { key: "primarylines", label: "Primary Line", geometry: "line", color: "#f97316", width: 3, visible: true, feederColor: true },
  { key: "poles", label: "Poles", geometry: "point", color: "#00b400", radius: 5.25, visible: false, minZoom: 15, labelField: "nodeid" },
  { key: "secondarylines", label: "Secondary Lines", geometry: "line", color: "#00CED1", width: 2, visible: false, minZoom: 17, feederColor: true },
  { key: "transformers", label: "Transformers", geometry: "point", color: "#2563eb", radius: 6, visible: false, minZoom: 16 },
  { key: "fco", label: "FCO", geometry: "point", color: "#14b8a6", radius: 6, visible: false },
  { key: "recloser", label: "Recloser", geometry: "point", color: "#f59e0b", radius: 6, visible: false },
  { key: "ds", label: "DS", geometry: "point", color: "#a855f7", radius: 6, visible: false },
  { key: "lbs", label: "LBS", geometry: "point", color: "#ef4444", radius: 6, visible: false },
];

function makeGisLayerEndpointMap() {
  return {
    primarylines: API_ENDPOINTS.gisPrimary,
    poles: API_ENDPOINTS.gisPoles,
    secondarylines: API_ENDPOINTS.gisSecondary,
    transformers: API_ENDPOINTS.gisTransformers,
    fco: API_ENDPOINTS.gisFco,
    recloser: API_ENDPOINTS.gisRecloser,
    ds: API_ENDPOINTS.gisDs,
    lbs: API_ENDPOINTS.gisLbs,
  };
}

const EMPTY_FEATURE_COLLECTION = { type: "FeatureCollection", features: [] };

function normalizeFeatureCollection(value) {
  if (value?.type === "FeatureCollection" && Array.isArray(value.features)) return value;
  if (Array.isArray(value?.features)) return { type: "FeatureCollection", features: value.features };
  if (Array.isArray(value)) return { type: "FeatureCollection", features: value };
  return EMPTY_FEATURE_COLLECTION;
}

function normalizeGisLayerPayload(payload) {
  const sourceLayers = payload?.layers || payload || {};
  return {
    layers: GIS_LAYER_DEFINITIONS.reduce((acc, layer) => {
      acc[layer.key] = normalizeFeatureCollection(sourceLayers[layer.key]);
      return acc;
    }, {}),
  };
}

function safeScriptJson(value) {
  return JSON.stringify(value || {}).replace(/</g, "\\u003c");
}
function visitCoordinates(coordinates, visitor) {
  if (!Array.isArray(coordinates)) return;
  if (typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
    visitor(coordinates[0], coordinates[1]);
    return;
  }
  coordinates.forEach((entry) => visitCoordinates(entry, visitor));
}

function featureTouchesWindow(feature, center, radiusDegrees) {
  const geometry = feature?.geometry;
  if (!geometry?.coordinates) return false;
  let matched = false;
  visitCoordinates(geometry.coordinates, (lon, lat) => {
    if (matched) return;
    matched = Math.abs(Number(lat) - center.latitude) <= radiusDegrees
      && Math.abs(Number(lon) - center.longitude) <= radiusDegrees;
  });
  return matched;
}

function buildOpenLayersHtml(center, gisLayerPayload, gisLayerStats) {
  const lat = Number(center?.latitude) || 16.4023;
  const lon = Number(center?.longitude) || 120.5960;
  const gisLayersJson = safeScriptJson(normalizeGisLayerPayload(gisLayerPayload));
  const gisLayerDefinitionsJson = safeScriptJson(GIS_LAYER_DEFINITIONS);
  const gisLayerStatsJson = safeScriptJson(gisLayerStats || {});
  const feederColorsJson = safeScriptJson(FEEDER_COLORS);
  return `<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/ol@v10.6.1/ol.css">
  <style>
    html, body, #map { width: 100%; height: 100%; margin: 0; padding: 0; background: #07111f; }
    body { overflow: hidden; }
    .ol-attribution { font-size: 10px; }
    .marker { width: 18px; height: 18px; border-radius: 50%; background: #38bdf8; border: 3px solid #ffffff; box-shadow: 0 0 0 4px rgba(56,189,248,.3); transform: translate(-50%, -50%); }
    .hint { position: absolute; left: 12px; right: 12px; bottom: 12px; z-index: 2; background: rgba(2,6,23,.82); color: #f8fafc; border: 1px solid rgba(148,163,184,.35); border-radius: 8px; padding: 10px 12px; font-family: Arial, sans-serif; font-size: 13px; pointer-events: none; }
    .north-tool { position: absolute; top: 12px; right: 12px; z-index: 4; pointer-events: auto; }
    .center-tool { position: absolute; right: 12px; bottom: 70px; z-index: 4; pointer-events: auto; }
    .layer-switcher { position: absolute; top: 12px; left: 12px; z-index: 4; font-family: Arial, sans-serif; pointer-events: auto; }
    .layer-toggle, button.icon { min-height: 42px; border: 1px solid rgba(148,163,184,.45); border-radius: 8px; padding: 0 12px; color: #e2e8f0; background: rgba(15,23,42,.92); font-size: 13px; font-weight: 900; box-shadow: 0 8px 22px rgba(2,6,23,.25); }
    .layer-toggle.active { color: #ffffff; border-color: #22c55e; background: rgba(15,139,76,.95); }
    button.icon { min-width: 42px; padding: 0 10px; font-size: 17px; }
    .layer-panel { display: none; width: 232px; max-height: 70vh; overflow-y: auto; margin-top: 8px; border: 1px solid rgba(148,163,184,.38); border-radius: 9px; background: rgba(2,6,23,.92); box-shadow: 0 12px 30px rgba(2,6,23,.38); color: #e2e8f0; }
    .layer-switcher.open .layer-panel { display: block; }
    .layer-section { padding: 10px; border-top: 1px solid rgba(148,163,184,.18); }
    .layer-section:first-child { border-top: 0; }
    .layer-heading { margin-bottom: 8px; color: #f8fafc; font-size: 11px; font-weight: 900; text-transform: uppercase; letter-spacing: .04em; }
    .layer-option { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 5px 3px; font-size: 13px; font-weight: 800; }
    .layer-option input { width: 18px; height: 18px; accent-color: #16a34a; }
    .layer-option.empty { color: #94a3b8; }
    .layer-option.scale-hidden { opacity: .58; }
    .layer-minzoom { color: #fbbf24; font-size: 10px; font-weight: 900; }
    .layer-count { margin-left: auto; color: #7dd3fc; font-size: 11px; font-weight: 900; }
    #poleHtmlLayer { position: absolute; inset: 0; z-index: 3; pointer-events: none; overflow: hidden; }
    .pole-marker { position: absolute; width: 10.5px; height: 10.5px; border-radius: 50%; background: #00b400; border: 2.25px solid rgba(255,255,255,.95); box-shadow: 0 0 0 2.25px rgba(0,180,0,.25); transform: translate(-50%, -50%); pointer-events: none; }
    .pole-label { position: absolute; left: 50%; top: -20px; transform: translateX(-50%); color: #111827; background: rgba(255,255,255,.9); border-radius: 3px; padding: 1px 3px; font: 900 11px Arial, sans-serif; white-space: nowrap; text-shadow: 0 1px 0 #fff; }
  </style>
</head>
<body>
  <div id="map"></div>
  <div id="poleHtmlLayer"></div>
  <div class="layer-switcher" id="layerSwitcher">
    <button class="layer-toggle" id="layerToggle" type="button">Layers</button>
    <div class="layer-panel" id="layerPanel">
      <div class="layer-section">
        <div class="layer-heading">Map Background</div>
        <label class="layer-option"><input type="radio" name="basemap" value="googleHybrid" checked>Google Hybrid</label>
        <label class="layer-option"><input type="radio" name="basemap" value="googleMap">Google Map</label>
        <label class="layer-option"><input type="radio" name="basemap" value="osm">OpenStreetMap</label>
      </div>
      <div class="layer-section" id="overlayOptions">
        <div class="layer-heading">GIS Layers</div>
      </div>
    </div>
  </div>
  <button class="icon north-tool" id="northButton" type="button" title="Reset north">N</button>
  <button class="icon center-tool" id="centerButton" type="button" title="Re-center current location">◎</button>
  <div class="hint">Tap the map to choose the MO location.</div>
  <script src="https://cdn.jsdelivr.net/npm/ol@v10.6.1/dist/ol.js"></script>
  <script>
    const initialLon = ${lon};
    const initialLat = ${lat};
    const initialCoordinate = ol.proj.fromLonLat([initialLon, initialLat]);
    const gisLayerPayload = ${gisLayersJson};
    const gisLayerDefinitions = ${gisLayerDefinitionsJson};
    const gisLayerStats = ${gisLayerStatsJson};
    const feederColors = ${feederColorsJson};
    const geoJsonFormat = new ol.format.GeoJSON();
    const sources = {
      googleHybrid: new ol.source.XYZ({ url: 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', attributions: 'Map data &copy; Google', maxZoom: 22 }),
      googleMap: new ol.source.XYZ({ url: 'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', attributions: 'Map data &copy; Google', maxZoom: 22 }),
      osm: new ol.source.XYZ({ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attributions: '&copy; OpenStreetMap contributors', maxZoom: 19 })
    };
    const baseLayer = new ol.layer.Tile({ source: sources.googleHybrid });
    function truthyStatus(value) {
      return value === 1 || value === "1" || value === true || String(value || "").toUpperCase() === "CLOSE";
    }
    function getFeatureValue(feature, names) {
      for (const name of names) {
        const value = feature.get(name);
        if (value !== undefined && value !== null && String(value).trim()) return value;
      }
      return "";
    }
    function getFeatureFeeder(feature) {
      return String(getFeatureValue(feature, ["feederid", "feeder_id", "feeder", "FEEDERID", "FEEDER_ID", "FEEDER", "circuitid", "circuit_id", "CIRCUITID", "CIRCUIT_ID"])).trim().toUpperCase();
    }
    function lineColorForFeature(definition, feature) {
      const energized = getFeatureValue(feature, ["energized", "ENERGIZED", "status", "STATUS"]);
      if (energized !== "" && !truthyStatus(energized)) return "rgba(0, 255, 0, .9)";
      if (definition.feederColor) return feederColors[getFeatureFeeder(feature)] || definition.color;
      return definition.color;
    }
    function makeVectorStyle(definition) {
      return function(feature) {
        const geometryType = feature.getGeometry()?.getType?.() || "";
        if (geometryType.includes("Line")) {
          const energized = getFeatureValue(feature, ["energized", "ENERGIZED", "status", "STATUS"]);
          const isOpen = energized !== "" && !truthyStatus(energized);
          return new ol.style.Style({
            stroke: new ol.style.Stroke({
              color: lineColorForFeature(definition, feature),
              width: definition.width || 3,
              lineDash: isOpen ? [10, 10] : undefined
            })
          });
        }
        if (geometryType.includes("Polygon")) {
          return new ol.style.Style({
            stroke: new ol.style.Stroke({ color: definition.color, width: 2 }),
            fill: new ol.style.Fill({ color: definition.color + "33" })
          });
        }
        const labelValue = definition.labelField ? getFeatureValue(feature, [definition.labelField, definition.labelField.toUpperCase(), "NODEID", "node_id", "poleid", "POLEID"]) : "";
        if (definition.key === "poles") {
          const geometry = feature.getGeometry();
          return new ol.style.Style({
            geometry,
            image: new ol.style.Circle({
              radius: definition.radius || 5.25,
              fill: new ol.style.Fill({ color: "rgba(0,180,0,1)" }),
              stroke: new ol.style.Stroke({ color: "rgba(255,255,255,.95)", width: 3 })
            }),
            text: labelValue ? new ol.style.Text({
              text: String(labelValue),
              font: "bold 12px Arial",
              fill: new ol.style.Fill({ color: "#111827" }),
              stroke: new ol.style.Stroke({ color: "#ffffff", width: 3 }),
              offsetY: -15
            }) : undefined
          });
        }
        return new ol.style.Style({
          image: new ol.style.Circle({
            radius: definition.radius || 5,
            fill: new ol.style.Fill({ color: definition.color }),
            stroke: new ol.style.Stroke({ color: "rgba(255,255,255,.85)", width: 1.5 })
          })
        });
      };
    }
    const gisLayers = {};
    gisLayerDefinitions.forEach(function(definition) {
      const collection = gisLayerPayload.layers?.[definition.key] || { type: "FeatureCollection", features: [] };
      const source = new ol.source.Vector({
        features: geoJsonFormat.readFeatures(collection, { featureProjection: "EPSG:3857" })
      });
      const layer = new ol.layer.Vector({
        source,
        style: makeVectorStyle(definition),
        visible: Boolean(definition.visible && source.getFeatures().length),
        zIndex: definition.key === "poles" ? 45 : definition.geometry === "line" ? 20 : 35
      });
      gisLayers[definition.key] = layer;
    });
    const markerElement = document.createElement('div');
    markerElement.className = 'marker';
    const marker = new ol.Overlay({ element: markerElement, positioning: 'center-center', stopEvent: false });
    const view = new ol.View({
      center: initialCoordinate,
      zoom: 17,
      maxZoom: 22,
      enableRotation: true
    });
    const map = new ol.Map({
      target: 'map',
      overlays: [marker],
      layers: [baseLayer].concat(Object.values(gisLayers)),
      view,
      controls: ol.control.defaults.defaults({ rotate: false })
    });
    marker.setPosition(initialCoordinate);
    function stopMapEvent(event) {
      event.stopPropagation();
    }
    function bindTap(element, action) {
      let touchedAt = 0;
      element.addEventListener('pointerdown', stopMapEvent);
      element.addEventListener('touchstart', stopMapEvent, { passive: true });
      element.addEventListener('touchend', function(event) {
        touchedAt = Date.now();
        event.preventDefault();
        event.stopPropagation();
        action(event);
      }, { passive: false });
      element.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        if (Date.now() - touchedAt > 450) action(event);
      });
    }
    ['layerSwitcher', 'layerPanel'].forEach(function(id) {
      const element = document.getElementById(id);
      element.addEventListener('pointerdown', stopMapEvent);
      element.addEventListener('touchstart', stopMapEvent, { passive: true });
      element.addEventListener('click', stopMapEvent);
    });
    bindTap(document.getElementById('layerToggle'), function() {
      const switcher = document.getElementById('layerSwitcher');
      switcher.classList.toggle('open');
      document.getElementById('layerToggle').classList.toggle('active', switcher.classList.contains('open'));
    });
    bindTap(document.getElementById('northButton'), function() {
      view.animate({ rotation: 0, duration: 220 });
    });
    bindTap(document.getElementById('centerButton'), function() {
      view.animate({ center: initialCoordinate, zoom: Math.max(view.getZoom() || 17, 17), duration: 250 });
      marker.setPosition(initialCoordinate);
    });
    document.querySelectorAll('input[name="basemap"]').forEach(function(input) {
      input.addEventListener('change', function(event) {
        event.stopPropagation();
        if (input.checked) baseLayer.setSource(sources[input.value]);
      });
    });
    const overlayOptions = document.getElementById('overlayOptions');
    const layerInputs = {};
    const layerRows = {};
    const layerCounts = {};
    function setLayerCount(definition) {
      const layer = gisLayers[definition.key];
      const featureCount = layer?.getSource?.().getFeatures().length || 0;
      const row = layerRows[definition.key];
      const count = layerCounts[definition.key];
      if (row) row.classList.toggle('empty', featureCount === 0);
      if (count) {
        const totalCount = Number(gisLayerStats?.[definition.key]?.count || 0);
        count.textContent = totalCount ? String(featureCount) + ' / ' + String(totalCount) : String(featureCount);
      }
    }
    function clearPoleOverlays() {
      const layer = document.getElementById('poleHtmlLayer');
      if (layer) layer.innerHTML = '';
    }
    function getPoleLabel(feature) {
      return getFeatureValue(feature, ["nodeid", "NODEID", "node_id", "poleid", "POLEID"]);
    }
    function getPoleCoordinates(feature) {
      const geometry = feature?.getGeometry?.();
      if (!geometry) return [];
      const type = geometry.getType?.();
      if (type === "Point") return [geometry.getCoordinates()];
      if (type === "MultiPoint") return geometry.getCoordinates();
      return [];
    }
    function syncPoleOverlays() {
      const htmlLayer = document.getElementById('poleHtmlLayer');
      if (!htmlLayer) return;
      htmlLayer.innerHTML = '';
      const definition = gisLayerDefinitions.find(function(entry) { return entry.key === "poles"; });
      const input = layerInputs.poles;
      const zoom = view.getZoom() || 0;
      if (!definition || !input?.checked || (definition.minZoom && zoom < definition.minZoom)) return;
      const source = gisLayers.poles?.getSource?.();
      const size = map.getSize();
      if (!source || !size) return;
      source.getFeatures().forEach(function(feature) {
        const label = getPoleLabel(feature);
        getPoleCoordinates(feature).forEach(function(coordinate) {
          const pixel = map.getPixelFromCoordinate(coordinate);
          if (!pixel || pixel[0] < -40 || pixel[1] < -40 || pixel[0] > size[0] + 40 || pixel[1] > size[1] + 40) return;
          const marker = document.createElement('div');
          marker.className = 'pole-marker';
          marker.style.left = pixel[0] + 'px';
          marker.style.top = pixel[1] + 'px';
          if (label) {
            const labelNode = document.createElement('span');
            labelNode.className = 'pole-label';
            labelNode.textContent = String(label);
            marker.appendChild(labelNode);
          }
          htmlLayer.appendChild(marker);
        });
      });
    }
    function applyScaleVisibility() {
      const zoom = view.getZoom() || 0;
      gisLayerDefinitions.forEach(function(definition) {
        const layer = gisLayers[definition.key];
        const input = layerInputs[definition.key];
        const row = layerRows[definition.key];
        const allowed = !definition.minZoom || zoom >= definition.minZoom;
        if (row) row.classList.toggle('scale-hidden', !allowed);
        if (layer && input) layer.setVisible(Boolean(input.checked && allowed));
      });
      syncPoleOverlays();
    }
    gisLayerDefinitions.forEach(function(definition) {
      const layer = gisLayers[definition.key];
      const label = document.createElement('label');
      label.className = 'layer-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(definition.visible);
      input.setAttribute('data-gis-layer', definition.key);
      const textNode = document.createTextNode(definition.label);
      const count = document.createElement('span');
      count.className = 'layer-count';
      label.appendChild(input);
      label.appendChild(textNode);
      if (definition.minZoom) {
        const minZoom = document.createElement('span');
        minZoom.className = 'layer-minzoom';
        minZoom.textContent = definition.minZoom + '+';
        label.appendChild(minZoom);
      }
      label.appendChild(count);
      overlayOptions.appendChild(label);
      layerInputs[definition.key] = input;
      layerRows[definition.key] = label;
      layerCounts[definition.key] = count;
      setLayerCount(definition);
      input.addEventListener('change', function(event) {
        event.stopPropagation();
        if (input.checked && definition.minZoom && (view.getZoom() || 0) < definition.minZoom) {
          view.animate({ zoom: definition.minZoom + 0.2, duration: 300 });
        }
        applyScaleVisibility();
      });
      label.addEventListener('pointerdown', stopMapEvent);
      label.addEventListener('touchstart', stopMapEvent, { passive: true });
      label.addEventListener('click', stopMapEvent);
    });
    function updateGisLayers(payload) {
      const nextLayers = payload?.layers || {};
      gisLayerDefinitions.forEach(function(definition) {
        const layer = gisLayers[definition.key];
        const source = layer?.getSource?.();
        if (!source) return;
        const collection = nextLayers[definition.key] || { type: "FeatureCollection", features: [] };
        const features = geoJsonFormat.readFeatures(collection, { featureProjection: "EPSG:3857" });
        source.clear(true);
        source.addFeatures(features);
        setLayerCount(definition);
      });
      applyScaleVisibility();
    }
    window.updateGisLayers = updateGisLayers;
    function requestGisLayersForViewport() {
      const size = map.getSize();
      if (!size) return;
      const extent = view.calculateExtent(size);
      const bottomLeft = ol.proj.toLonLat([extent[0], extent[1]]);
      const topRight = ol.proj.toLonLat([extent[2], extent[3]]);
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: "requestGisLayers",
        zoom: view.getZoom() || 17,
        bounds: {
          minLon: bottomLeft[0],
          minLat: bottomLeft[1],
          maxLon: topRight[0],
          maxLat: topRight[1]
        }
      }));
    }
    let layerRequestTimer = null;
    function scheduleGisLayerRequest() {
      clearTimeout(layerRequestTimer);
      layerRequestTimer = setTimeout(requestGisLayersForViewport, 260);
    }
    view.on('change:resolution', function() {
      applyScaleVisibility();
      syncPoleOverlays();
    });
    map.on('moveend', function() {
      scheduleGisLayerRequest();
      syncPoleOverlays();
    });
    applyScaleVisibility();
    setTimeout(scheduleGisLayerRequest, 450);
    map.on('singleclick', function(evt) {
      const lonLat = ol.proj.toLonLat(evt.coordinate);
      marker.setPosition(evt.coordinate);
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: "selectLocation", latitude: lonLat[1], longitude: lonLat[0] }));
    });
  </script>
</body>
</html>`;
}

function uniq(values) {
  return Array.from(new Set(values.map((value) => clean(value)).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function isGisAdmin(user) {
  return Array.isArray(user?.appAccess) && user.appAccess.some((entry) => {
    const appCode = clean(entry?.appCode || entry?.app_code).toLowerCase();
    const accessLevel = clean(entry?.accessLevel || entry?.access_level).toLowerCase();
    return appCode === "gis" && accessLevel === "admin";
  });
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function makePayload({ form, user, deviceId, localId, images, endorsedUsers }) {
  const now = new Date().toISOString();
  const payload = {
    client_local_id: localId,
    client_device_id: deviceId,
    created_source: "mobile",
    event_time: now,
    lon: Number(clean(form.lon)),
    lat: Number(clean(form.lat)),
    address: clean(form.address),
    municipality: clean(form.municipality),
    barangay: clean(form.barangay),
    feeder: clean(form.feeder),
    report_type: clean(form.reportType) || "Others",
    report_desc: clean(form.reportDesc),
    remarks: clean(form.remarks),
    status: "OPEN",
    label: clean(form.reportDesc) || clean(form.address) || localId,
    reported_by: user?.username || "mobile",
    images,
    created_at: now,
  };
  if (endorsedUsers.length > 0) {
    payload.endorsed_to = endorsedUsers;
    payload.endorsed_by = user?.fullname || user?.fullName || user?.username || "mobile";
    payload.visible_on = clean(form.visibleOn);
  }
  return payload;
}

function normalizeEditStatus(value) {
  const status = clean(value).toUpperCase();
  return status === "CLOSED" || status === "CLOSE" ? "CLOSED" : "OPEN";
}

function parseEditEndorsedTo(value) {
  if (Array.isArray(value)) return value;
  const raw = clean(value);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getEditCoordinates(report) {
  const coordinates = Array.isArray(report?.geometry?.coordinates) ? report.geometry.coordinates : [];
  return {
    lon: report?.lon ?? report?.longitude ?? coordinates[0] ?? "",
    lat: report?.lat ?? report?.latitude ?? coordinates[1] ?? "",
  };
}

function makeFormFromReport(report) {
  const coords = getEditCoordinates(report || {});
  return {
    reportType: clean(report?.reportType ?? report?.report_type),
    reportDesc: clean(report?.reportDesc ?? report?.report_desc),
    address: clean(report?.address),
    municipality: clean(report?.municipality),
    barangay: clean(report?.barangay),
    feeder: clean(report?.feeder),
    lon: clean(coords.lon),
    lat: clean(coords.lat),
    remarks: clean(report?.remarks),
    visibleOn: clean(report?.visibleOn ?? report?.visible_on),
  };
}

function makeUpdatePayload({ form, report, user, images, endorsedUsers }) {
  const status = normalizeEditStatus(report?.status);
  const payload = {
    event_time: report?.eventTime || report?.event_time || new Date().toISOString(),
    lon: Number(clean(form.lon)),
    lat: Number(clean(form.lat)),
    address: clean(form.address),
    municipality: clean(form.municipality),
    barangay: clean(form.barangay),
    feeder: clean(form.feeder),
    report_type: clean(form.reportType) || "Others",
    report_desc: clean(form.reportDesc),
    remarks: clean(form.remarks),
    status,
    label: clean(form.reportDesc) || clean(form.address) || `MO #${report?.id || ""}`,
    images,
  };
  if (status === "CLOSED") {
    payload.accomplished_date = report?.accomplishedDate || report?.accomplished_date || new Date().toISOString();
    payload.accomplished_by = report?.accomplishedBy || report?.accomplished_by || user?.fullname || user?.fullName || user?.username || "mobile";
    payload.accomplishment = report?.accomplishment || "Updated from mobile app.";
  }
  if (endorsedUsers.length > 0) {
    payload.endorsed_to = endorsedUsers;
    payload.endorsed_by = user?.fullname || user?.fullName || user?.username || "mobile";
    payload.visible_on = clean(form.visibleOn);
  }
  return payload;
}

async function fetchJson(url, token) {
  const response = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.message || "Lookup request failed.");
  return data;
}

function EndorsementPicker({ users, selectedIds, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedUsers = useMemo(() => users.filter((entry) => selectedIds.includes(entry.id)), [selectedIds, users]);
  const filteredUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((entry) => [entry.fullname, entry.username, entry.alias, entry.position].some((value) => clean(value).toLowerCase().includes(q)));
  }, [query, users]);

  function toggle(id) {
    onChange(selectedIds.includes(id) ? selectedIds.filter((value) => value !== id) : [...selectedIds, id]);
  }

  return (
    <View style={styles.fieldBlock}>
      <Text style={styles.label}>Endorsed To</Text>
      <Pressable onPress={() => setOpen(true)} style={styles.selectButton}>
        <Text style={[styles.selectText, selectedUsers.length === 0 && styles.placeholderText]} numberOfLines={1}>
          {selectedUsers.length ? `${selectedUsers.length} selected` : "Select user(s)"}
        </Text>
        <Text style={styles.selectArrow}>v</Text>
      </Pressable>
      {selectedUsers.length > 0 ? <Text style={styles.selectedHint} numberOfLines={2}>{selectedUsers.map((entry) => entry.alias || entry.fullname || entry.username).join(", ")}</Text> : null}
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.pickerPanel} onPress={(event) => event.stopPropagation?.()}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>Endorsed To</Text>
              <Pressable onPress={() => setOpen(false)} style={styles.pickerCloseButton}>
                <Text style={styles.pickerCloseText}>Done</Text>
              </Pressable>
            </View>
            <TextInput value={query} onChangeText={setQuery} placeholder="Search name, alias, position" placeholderTextColor="#64748b" style={styles.pickerSearch} />
            <ScrollView style={styles.pickerScroll} keyboardShouldPersistTaps="handled">
              {filteredUsers.length === 0 ? <Text style={styles.emptyPickerText}>No users found.</Text> : null}
              {filteredUsers.map((entry) => {
                const active = selectedIds.includes(entry.id);
                return (
                  <Pressable key={entry.id} onPress={() => toggle(entry.id)} style={[styles.optionRow, active && styles.optionRowActive]}>
                    <Text style={[styles.optionText, active && styles.optionTextActive]} numberOfLines={1}>{entry.alias ? `${entry.fullname} (${entry.alias})` : entry.fullname}</Text>
                    <Text style={[styles.optionSubText, active && styles.optionTextActive]} numberOfLines={1}>{entry.position || entry.username}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
function PickerField({ label, value, placeholder, options, disabled, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((option) => option.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <View style={styles.fieldBlock}>
      <Text style={styles.label}>{label}</Text>
      <Pressable disabled={disabled} onPress={() => setOpen(true)} style={[styles.selectButton, disabled && styles.inputDisabled]}>
        <Text style={[styles.selectText, !value && styles.placeholderText]} numberOfLines={1}>{value || placeholder}</Text>
        <Text style={styles.selectArrow}>v</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.pickerPanel} onPress={(event) => event.stopPropagation?.()}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>{label}</Text>
              <Pressable onPress={() => setOpen(false)} style={styles.pickerCloseButton}>
                <Text style={styles.pickerCloseText}>Close</Text>
              </Pressable>
            </View>
            <TextInput value={query} onChangeText={setQuery} placeholder="Search" placeholderTextColor="#64748b" style={styles.pickerSearch} />
            <ScrollView style={styles.pickerScroll} keyboardShouldPersistTaps="handled">
              <Pressable onPress={() => { onChange(""); setOpen(false); }} style={styles.optionRow}>
                <Text style={styles.optionText}>{placeholder}</Text>
              </Pressable>
              {filtered.map((option) => (
                <Pressable key={option} onPress={() => { onChange(option); setOpen(false); }} style={[styles.optionRow, value === option && styles.optionRowActive]}>
                  <Text style={[styles.optionText, value === option && styles.optionTextActive]}>{option}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function PendingItem({ item }) {
  const title = item.serverMoId ? `MO #${item.serverMoId}` : `Local ${item.localId.slice(-12)}`;
  const statusColor = item.syncStatus === "synced" ? "#86efac" : item.syncStatus === "failed" ? "#fecdd3" : "#fbbf24";
  return (
    <View style={styles.pendingItem}>
      <View style={styles.pendingTopRow}>
        <Text style={styles.pendingTitle}>{title}</Text>
        <Text style={[styles.pendingStatus, { color: statusColor }]}>{item.syncStatus.toUpperCase()}</Text>
      </View>
      <Text style={styles.pendingDetail} numberOfLines={2}>{item.payload?.report_desc || item.payload?.address || "Maintenance order"}</Text>
      <Text style={styles.pendingMeta}>{formatDateTime(item.createdAt)}</Text>
      {item.errorMessage ? <Text style={styles.pendingError}>{item.errorMessage}</Text> : null}
    </View>
  );
}

export default function AddJobScreen({ token, user, editReport, onCancelEdit, onSyncStatusChange, onSaved }) {
  const [form, setForm] = useState(INITIAL_FORM);
  const [deviceId, setDeviceId] = useState("");
  const [pendingItems, setPendingItems] = useState([]);
  const [lookups, setLookups] = useState({ reportTypes: [], reportDescriptions: [], municipalities: [], barangays: [], feeders: [], users: [] });
  const [gisLayers, setGisLayers] = useState(() => normalizeGisLayerPayload(null));
  const [gisLayerStats, setGisLayerStats] = useState({});
  const [images, setImages] = useState([]);
  const [endorsedIds, setEndorsedIds] = useState([]);
  const [locating, setLocating] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [mapCandidate, setMapCandidate] = useState(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("info");
  const mapWebViewRef = useRef(null);

  const canEndorse = isGisAdmin(user);
  const endorsedUsers = useMemo(() => lookups.users.filter((entry) => endorsedIds.includes(entry.id)), [endorsedIds, lookups.users]);
  const canSave = useMemo(() => clean(form.reportDesc) && clean(form.lon) && clean(form.lat) && !saving, [form, saving]);
  const editing = Boolean(editReport?.id);

  const refreshPending = useCallback(async () => {
    const items = await listPendingMaintenanceReports({ includeSynced: true });
    setPendingItems(items.slice(0, 8));
  }, []);

  const useGpsLocation = useCallback(async () => {
    setLocating(true);
    setMessage("");
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") throw new Error("Location permission is required to add an MO from the phone.");
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setForm((current) => ({
        ...current,
        lon: String(position.coords.longitude.toFixed(6)),
        lat: String(position.coords.latitude.toFixed(6)),
      }));
      setMessageType("success");
      setMessage("GPS location captured.");
    } catch (error) {
      setMessageType("error");
      setMessage(error?.message || "Unable to get GPS location.");
    } finally {
      setLocating(false);
    }
  }, []);

  async function openMapPicker() {
    const formLat = Number(clean(form.lat));
    const formLon = Number(clean(form.lon));
    let initial = Number.isFinite(formLat) && Number.isFinite(formLon)
      ? { latitude: formLat, longitude: formLon }
      : { latitude: 16.4023, longitude: 120.5960 };

    setLocating(true);
    setMessage("");
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") throw new Error("Location permission was not granted.");
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      initial = {
        latitude: Number(position.coords.latitude.toFixed(6)),
        longitude: Number(position.coords.longitude.toFixed(6)),
      };
    } catch {
      setMessageType("info");
      setMessage("Unable to get current GPS. Map opened using the last saved location.");
    } finally {
      const layerKeys = GIS_LAYER_DEFINITIONS.map((layer) => layer.key);
      const [nearbyLayers, cacheStats] = await Promise.all([
        getCachedGisLayersForCenter(initial, 0.04, layerKeys),
        getGisLayerCacheStats(layerKeys),
      ]);
      setGisLayers(normalizeGisLayerPayload(nearbyLayers));
      setGisLayerStats(cacheStats);
      setLocating(false);
      setMapCandidate(initial);
      setMapOpen(true);
    }
  }

  function confirmMapLocation(coordinate) {
    if (!coordinate) return;
    Alert.alert(
      "Use this location?",
      coordinate.latitude.toFixed(6) + ", " + coordinate.longitude.toFixed(6),
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Use Location",
          onPress: () => {
            setForm((current) => ({
              ...current,
              lat: String(coordinate.latitude.toFixed(6)),
              lon: String(coordinate.longitude.toFixed(6)),
            }));
            setMapCandidate(coordinate);
            setMapOpen(false);
            setMessageType("success");
            setMessage("Map location selected.");
          },
        },
      ]
    );
  }

  async function handleMapMessage(event) {
    try {
      const message = JSON.parse(event?.nativeEvent?.data || "{}");
      if (message?.type === "requestGisLayers") {
        const layerPayload = await getCachedGisLayersForBbox(message.bounds, GIS_LAYER_DEFINITIONS.map((layer) => layer.key));
        const normalized = normalizeGisLayerPayload(layerPayload);
        mapWebViewRef.current?.injectJavaScript(`window.updateGisLayers && window.updateGisLayers(${safeScriptJson(normalized)}); true;`);
        return;
      }
      if (message?.type && message.type !== "selectLocation") return;
      const latitude = Number(message.latitude);
      const longitude = Number(message.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
      confirmMapLocation({ latitude, longitude });
    } catch {
      // Ignore malformed messages from the embedded map.
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      const id = await getDeviceId();
      if (!cancelled) setDeviceId(id);
      await refreshPending();
      try {
        const [typeData, municipalityData, feederData, userData] = await Promise.all([
          fetchJson(API_ENDPOINTS.maintenanceReportTypes, token),
          fetchJson(API_ENDPOINTS.municipalities, token),
          fetchJson(API_ENDPOINTS.feeders, token),
          canEndorse ? fetchJson(API_ENDPOINTS.maintenanceEndorsementUsers, token) : Promise.resolve({ users: [] }),
        ]);
        if (!cancelled) {
          setLookups((current) => ({
            ...current,
            reportTypes: uniq(typeData.reportTypes || []),
            municipalities: uniq(municipalityData.municipalities || []),
            feeders: uniq(feederData.feeders || []),
            users: Array.isArray(userData.users) ? userData.users : [],
          }));
        }
      } catch {
        // Cached MO data still allows the user to save locally.
      }
      await useGpsLocation();
    }
    boot();
    return () => {
      cancelled = true;
    };
  }, [canEndorse, refreshPending, token, useGpsLocation]);

  useEffect(() => {
    let cancelled = false;
    async function loadDescriptions() {
      if (!form.reportType) {
        setLookups((current) => ({ ...current, reportDescriptions: [] }));
        return;
      }
      try {
        const params = new URLSearchParams({ reportType: form.reportType });
        const data = await fetchJson(`${API_ENDPOINTS.maintenanceReportDescriptions}?${params.toString()}`, token);
        if (!cancelled) setLookups((current) => ({ ...current, reportDescriptions: uniq(data.reportDescriptions || []) }));
      } catch {
        if (!cancelled) setLookups((current) => ({ ...current, reportDescriptions: [] }));
      }
    }
    loadDescriptions();
    return () => {
      cancelled = true;
    };
  }, [form.reportType, token]);

  useEffect(() => {
    let cancelled = false;
    async function loadBarangays() {
      if (!form.municipality) {
        setLookups((current) => ({ ...current, barangays: [] }));
        return;
      }
      try {
        const params = new URLSearchParams({ municipality: form.municipality });
        const data = await fetchJson(`${API_ENDPOINTS.barangays}?${params.toString()}`, token);
        if (!cancelled) setLookups((current) => ({ ...current, barangays: uniq(data.barangays || []) }));
      } catch {
        if (!cancelled) setLookups((current) => ({ ...current, barangays: [] }));
      }
    }
    loadBarangays();
    return () => {
      cancelled = true;
    };
  }, [form.municipality, token]);

  useEffect(() => {
    if (!editReport?.id) return;
    setForm(makeFormFromReport(editReport));
    setImages([]);
    setMessage("");
    setMessageType("info");
    const endorsed = parseEditEndorsedTo(editReport.endorsedTo ?? editReport.endorsed_to);
    setEndorsedIds(endorsed.map((entry) => Number(entry?.id ?? entry?.user_id)).filter((id) => Number.isFinite(id)));
  }, [editReport]);

  function updateField(key, value) {
    setForm((current) => ({ ...current, [key]: value, ...(key === "reportType" ? { reportDesc: "" } : {}), ...(key === "municipality" ? { barangay: "" } : {}) }));
  }

  async function pickImages() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (permission.status !== "granted") {
      setMessageType("error");
      setMessage("Photo permission is required to attach images.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsMultipleSelection: true, quality: 0.72 });
    if (result.canceled) return;
    const picked = (result.assets || []).map((asset, index) => ({
      uri: asset.uri,
      fileName: asset.fileName || `mo_photo_${Date.now()}_${index + 1}.jpg`,
      mimeType: asset.mimeType || "image/jpeg",
    }));
    setImages((current) => [...current, ...picked].slice(0, 10));
  }

  async function takePhoto() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (permission.status !== "granted") {
      setMessageType("error");
      setMessage("Camera permission is required to take a photo.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.72 });
    if (result.canceled) return;
    const captured = (result.assets || []).map((asset, index) => ({
      uri: asset.uri,
      fileName: asset.fileName || `mo_camera_${Date.now()}_${index + 1}.jpg`,
      mimeType: asset.mimeType || "image/jpeg",
    }));
    setImages((current) => [...current, ...captured].slice(0, 10));
  }

  async function runSync() {
    setSyncing(true);
    try {
      const result = await syncPendingMaintenanceReports({ token });
      onSyncStatusChange?.({ online: result.online });
      if (result.synced > 0) {
        const refreshed = await loadMaintenanceReports({ token });
        onSyncStatusChange?.(refreshed);
        onSaved?.();
      }
      await refreshPending();
      return result;
    } finally {
      setSyncing(false);
    }
  }

  async function handleSave() {
    if (!canSave) {
      setMessageType("error");
      setMessage("Report description and GPS location are required.");
      return;
    }

    const lon = Number(clean(form.lon));
    const lat = Number(clean(form.lat));
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      setMessageType("error");
      setMessage("Capture a valid GPS location before saving.");
      return;
    }

    setSaving(true);
    setMessage("");
    try {
      if (editing) {
        const payload = makeUpdatePayload({ form, report: editReport, user, images, endorsedUsers });
        const result = await updateMaintenanceReport({ token, id: editReport.id, payload });
        onSyncStatusChange?.(result.refreshed);
        onSaved?.(result);
        setMessageType("success");
        setMessage(`MO #${editReport.id} updated.`);
        setImages([]);
        return;
      }

      const id = deviceId || await getDeviceId();
      const localId = createLocalMaintenanceId(id);
      const payload = makePayload({ form, user, deviceId: id, localId, images, endorsedUsers });
      await savePendingMaintenanceReport(payload);
      await refreshPending();

      const result = await runSync();
      if (result.synced > 0) {
        setMessageType("success");
        setMessage("Maintenance order synced and assigned an official MO number.");
      } else {
        setMessageType("info");
        setMessage("Saved locally. It will sync automatically when online.");
      }
      setForm((current) => ({ ...INITIAL_FORM, lon: current.lon, lat: current.lat }));
      setImages([]);
      setEndorsedIds([]);
    } catch (error) {
      setMessageType("info");
      setMessage(error?.message || "Saved locally. It will sync automatically when online.");
      await refreshPending();
    } finally {
      setSaving(false);
    }
  }

  async function handleManualSync() {
    setMessage("");
    try {
      const result = await runSync();
      setMessageType(result.failed > 0 ? "info" : "success");
      setMessage(result.synced > 0 ? `Synced ${result.synced} maintenance order(s).` : "No pending maintenance orders synced.");
    } catch (error) {
      setMessageType("error");
      setMessage(error?.message || "Unable to sync pending maintenance orders.");
    }
  }

  function toggleEndorsedUser(id) {
    setEndorsedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.wrap}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.panel}>
          <View style={styles.formTitleRow}>
            <View style={styles.formTitleBlock}>
              <Text style={styles.sectionTitle}>{editing ? `Edit MO #${editReport.id}` : "Add Maintenance Order"}</Text>
              <Text style={styles.sectionSub}>{editing ? "Update the official maintenance order record." : "MO number is assigned by the server after sync. GPS supplies the location for this phone record."}</Text>
            </View>
            {editing ? (
              <Pressable onPress={onCancelEdit} style={styles.cancelEditButton}>
                <Text style={styles.cancelEditText}>Cancel</Text>
              </Pressable>
            ) : null}
          </View>

          <View style={styles.locationBox}>
            <View style={styles.locationTextBlock}>
              <Text style={styles.locationTitle}>GPS Location</Text>
              <Text style={styles.locationValue}>{form.lat && form.lon ? `${form.lat}, ${form.lon}` : "No GPS fix yet"}</Text>
            </View>
            <View style={styles.locationActions}>
              <Pressable onPress={useGpsLocation} disabled={locating} style={styles.smallButton}>
                <Text style={styles.smallButtonText}>{locating ? "Locating" : "Use GPS"}</Text>
              </Pressable>
              <Pressable onPress={openMapPicker} disabled={locating} style={[styles.smallButtonMuted, locating && styles.buttonPressed]}>
                <Text style={styles.smallButtonText}>{locating ? "Locating" : "Map"}</Text>
              </Pressable>
            </View>
          </View>

          <PickerField label="Report Type" value={form.reportType} placeholder="Select report type" options={lookups.reportTypes} onChange={(value) => updateField("reportType", value)} />
          <PickerField label="Report Description *" value={form.reportDesc} placeholder={form.reportType ? "Select description" : "Select report type first"} options={lookups.reportDescriptions} disabled={!form.reportType} onChange={(value) => updateField("reportDesc", value)} />

          <Text style={styles.label}>Address / Location</Text>
          <TextInput value={form.address} onChangeText={(value) => updateField("address", value)} placeholder="Location details" placeholderTextColor="#64748b" style={styles.input} />

          <View style={styles.twoCol}>
            <View style={styles.col}>
              <PickerField label="Municipality" value={form.municipality} placeholder="Select" options={lookups.municipalities} onChange={(value) => updateField("municipality", value)} />
            </View>
            <View style={styles.col}>
              <PickerField label="Barangay" value={form.barangay} placeholder={form.municipality ? "Select" : "Municipality first"} options={lookups.barangays} disabled={!form.municipality} onChange={(value) => updateField("barangay", value)} />
            </View>
          </View>

          <PickerField label="Feeder" value={form.feeder} placeholder="Select feeder" options={lookups.feeders} onChange={(value) => updateField("feeder", value)} />

          <Text style={styles.label}>Remarks</Text>
          <TextInput value={form.remarks} onChangeText={(value) => updateField("remarks", value)} placeholder="Remarks" placeholderTextColor="#64748b" multiline style={[styles.input, styles.textArea]} />

          <View style={styles.attachRow}>
            <View>
              <Text style={styles.labelNoMargin}>Images</Text>
              <Text style={styles.attachHint}>{images.length} selected</Text>
            </View>
            <View style={styles.attachButtons}>
              <Pressable onPress={takePhoto} style={styles.smallButtonMuted}>
                <Text style={styles.smallButtonText}>Take Photo</Text>
              </Pressable>
              <Pressable onPress={pickImages} style={styles.smallButton}>
                <Text style={styles.smallButtonText}>Add Image</Text>
              </Pressable>
            </View>
          </View>
          {images.length > 0 ? (
            <View style={styles.imageList}>{images.map((image, index) => <Text key={`${image.uri}-${index}`} style={styles.imageName} numberOfLines={1}>{image.fileName}</Text>)}</View>
          ) : null}

          {canEndorse ? (
            <View style={styles.endorseBox}>
              <Text style={styles.sectionTitleSmall}>Endorsement</Text>
              <Text style={styles.sectionSub}>Optional. You can also edit endorsement later on the web app.</Text>
              <EndorsementPicker users={lookups.users} selectedIds={endorsedIds} onChange={setEndorsedIds} />
              <Text style={styles.label}>Visible On</Text>
              <TextInput value={form.visibleOn} onChangeText={(value) => updateField("visibleOn", value)} placeholder="Optional: yyyy-mm-dd hh:mm" placeholderTextColor="#64748b" style={styles.input} />
            </View>
          ) : null}

          {message ? (
            <View style={[styles.messageBox, messageType === "error" ? styles.messageError : messageType === "success" ? styles.messageSuccess : styles.messageInfo]}>
              <Text style={styles.messageText}>{message}</Text>
            </View>
          ) : null}

          <Pressable onPress={handleSave} disabled={!canSave} style={({ pressed }) => [styles.saveButton, (!canSave || pressed) && styles.buttonPressed]}>
            {saving ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.saveButtonText}>{editing ? "Update Maintenance Order" : "Save Maintenance Order"}</Text>}
          </Pressable>
        </View>

        <Modal visible={mapOpen} animationType="slide" onRequestClose={() => setMapOpen(false)}>
          <View style={styles.mapScreen}>
            <View style={styles.mapHeader}>
              <View style={styles.mapHeaderTextBlock}>
                <Text style={styles.mapTitle}>Select MO Location</Text>
                <Text style={styles.mapSub}>Tap the map, then confirm the selected point.</Text>
              </View>
              <Pressable onPress={() => setMapOpen(false)} style={styles.mapCloseButton}>
                <Text style={styles.mapCloseText}>Close</Text>
              </Pressable>
            </View>
            {mapCandidate ? (
              <View style={styles.mapBody}>
                <WebView
                  ref={mapWebViewRef}
                  originWhitelist={["*"]}
                  source={{ html: buildOpenLayersHtml(mapCandidate, gisLayers, gisLayerStats) }}
                  style={styles.mapView}
                  javaScriptEnabled
                  domStorageEnabled
                  onMessage={handleMapMessage}
                />
              </View>
            ) : null}
          </View>
        </Modal>

        {!editing ? <View style={styles.panel}>
          <View style={styles.pendingHeader}>
            <View style={styles.pendingTitleBlock}>
              <Text style={styles.sectionTitle}>Mobile Sync Queue</Text>
              <Text style={styles.sectionSub}>{deviceId ? `Device ${deviceId}` : "Preparing device ID"}</Text>
            </View>
            <Pressable onPress={handleManualSync} disabled={syncing} style={styles.syncButton}>
              <Text style={styles.syncButtonText}>{syncing ? "Syncing" : "Sync"}</Text>
            </Pressable>
          </View>
          {pendingItems.length === 0 ? <Text style={styles.emptyText}>No local maintenance orders yet.</Text> : pendingItems.map((item) => <PendingItem key={item.localId} item={item} />)}
        </View> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: "#07111f" },
  content: { padding: 14, paddingBottom: 30 },
  panel: { backgroundColor: "#101b2c", borderColor: "#243247", borderWidth: 1, borderRadius: 8, padding: 14, marginBottom: 12 },
  formTitleRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 10 },
  formTitleBlock: { flex: 1, minWidth: 0 },
  cancelEditButton: { minHeight: 36, justifyContent: "center", borderWidth: 1, borderColor: "#334155", borderRadius: 7, paddingHorizontal: 11, backgroundColor: "#07111f" },
  cancelEditText: { color: "#7dd3fc", fontSize: 12, fontWeight: "900" },
  sectionTitle: { color: "#f8fafc", fontSize: 17, fontWeight: "900" },
  sectionTitleSmall: { color: "#f8fafc", fontSize: 14, fontWeight: "900" },
  sectionSub: { color: "#94a3b8", fontSize: 12, lineHeight: 18, marginTop: 4, marginBottom: 12 },
  fieldBlock: { marginTop: 10 },
  label: { color: "#dbeafe", fontSize: 11, fontWeight: "900", marginTop: 10, marginBottom: 6, textTransform: "uppercase" },
  labelNoMargin: { color: "#dbeafe", fontSize: 11, fontWeight: "900", textTransform: "uppercase" },
  input: { minHeight: 44, borderRadius: 7, borderWidth: 1, borderColor: "#334155", backgroundColor: "#07111f", color: "#f8fafc", fontSize: 14, paddingHorizontal: 11 },
  inputDisabled: { opacity: 0.55 },
  textArea: { minHeight: 84, paddingTop: 10, textAlignVertical: "top" },
  selectButton: { minHeight: 44, borderRadius: 7, borderWidth: 1, borderColor: "#334155", backgroundColor: "#07111f", paddingHorizontal: 11, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  selectText: { flex: 1, color: "#f8fafc", fontSize: 14, fontWeight: "800" },
  placeholderText: { color: "#64748b", fontWeight: "700" },
  selectArrow: { color: "#7dd3fc", fontSize: 12, fontWeight: "900" },
  modalBackdrop: { flex: 1, justifyContent: "center", backgroundColor: "rgba(2, 6, 23, 0.65)", padding: 18 },
  pickerPanel: { maxHeight: 520, borderRadius: 8, borderWidth: 1, borderColor: "#334155", backgroundColor: "#07111f", overflow: "hidden" },
  pickerHeader: { minHeight: 46, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: "#1e293b", backgroundColor: "#0b1424" },
  pickerTitle: { color: "#f8fafc", fontSize: 14, fontWeight: "900" },
  pickerCloseButton: { minHeight: 34, justifyContent: "center", paddingHorizontal: 8 },
  pickerCloseText: { color: "#7dd3fc", fontSize: 12, fontWeight: "900" },
  pickerSearch: { minHeight: 42, margin: 10, borderRadius: 7, borderWidth: 1, borderColor: "#334155", backgroundColor: "#0b1424", color: "#f8fafc", paddingHorizontal: 10 },
  pickerScroll: { maxHeight: 390 },
  optionRow: { minHeight: 42, justifyContent: "center", borderTopWidth: 1, borderTopColor: "#1e293b", paddingHorizontal: 12 },
  optionRowActive: { backgroundColor: "#0f8b4c" },
  optionText: { color: "#cbd5e1", fontSize: 13, fontWeight: "800" },
  optionTextActive: { color: "#ffffff" },
  optionSubText: { color: "#94a3b8", fontSize: 11, fontWeight: "700", marginTop: 2 },
  selectedHint: { color: "#7dd3fc", fontSize: 11, lineHeight: 16, marginTop: 6, fontWeight: "800" },
  emptyPickerText: { color: "#94a3b8", fontSize: 13, padding: 12, fontWeight: "700" },
  locationBox: { borderWidth: 1, borderColor: "#334155", borderRadius: 8, backgroundColor: "#07111f", padding: 12, marginTop: 12, flexDirection: "row", justifyContent: "space-between", gap: 10 },
  locationTextBlock: { flex: 1 },
  locationTitle: { color: "#f8fafc", fontSize: 13, fontWeight: "900" },
  locationValue: { color: "#94a3b8", fontSize: 12, marginTop: 4 },
  locationActions: { flexDirection: "row", gap: 7, alignItems: "center" },
  smallButton: { minHeight: 36, borderRadius: 7, borderWidth: 1, borderColor: "#22c55e", backgroundColor: "#0f8b4c", paddingHorizontal: 10, alignItems: "center", justifyContent: "center" },
  smallButtonMuted: { minHeight: 36, borderRadius: 7, borderWidth: 1, borderColor: "#334155", backgroundColor: "#101b2c", paddingHorizontal: 10, alignItems: "center", justifyContent: "center" },
  smallButtonText: { color: "#ffffff", fontSize: 12, fontWeight: "900" },
  mapScreen: { flex: 1, backgroundColor: "#07111f" },
  mapHeader: { minHeight: 84, paddingTop: 28, paddingHorizontal: 14, paddingBottom: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, backgroundColor: "#0b1424", borderBottomWidth: 1, borderBottomColor: "#1e293b" },
  mapHeaderTextBlock: { flex: 1 },
  mapTitle: { color: "#f8fafc", fontSize: 18, fontWeight: "900" },
  mapSub: { color: "#94a3b8", fontSize: 12, lineHeight: 17, marginTop: 3 },
  mapCloseButton: { minHeight: 40, justifyContent: "center", borderWidth: 1, borderColor: "#334155", borderRadius: 7, paddingHorizontal: 12, backgroundColor: "#101b2c" },
  mapCloseText: { color: "#7dd3fc", fontSize: 12, fontWeight: "900" },
  mapBody: { flex: 1, minHeight: 360, backgroundColor: "#07111f" },
  mapView: { flex: 1, width: "100%", height: "100%" },
  twoCol: { flexDirection: "row", gap: 9 },
  col: { flex: 1 },
  attachRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 14 },
  attachButtons: { flexDirection: "row", gap: 7, alignItems: "center" },
  attachHint: { color: "#94a3b8", fontSize: 12, marginTop: 3 },
  imageList: { gap: 5, marginTop: 8 },
  imageName: { color: "#cbd5e1", fontSize: 12, paddingVertical: 5, paddingHorizontal: 8, borderRadius: 6, backgroundColor: "#07111f", borderWidth: 1, borderColor: "#243247" },
  endorseBox: { borderTopWidth: 1, borderTopColor: "#243247", marginTop: 16, paddingTop: 13 },
  userGrid: { gap: 7 },
  userChip: { borderWidth: 1, borderColor: "#334155", backgroundColor: "#07111f", borderRadius: 7, padding: 9 },
  userChipActive: { backgroundColor: "#0f8b4c", borderColor: "#22c55e" },
  userNameText: { color: "#e2e8f0", fontSize: 12, fontWeight: "900" },
  userNameTextActive: { color: "#ffffff" },
  userMetaText: { color: "#94a3b8", fontSize: 11, marginTop: 2, fontWeight: "700" },
  saveButton: { alignItems: "center", justifyContent: "center", minHeight: 48, borderRadius: 7, backgroundColor: "#0f8b4c", marginTop: 14 },
  buttonPressed: { opacity: 0.7 },
  saveButtonText: { color: "#ffffff", fontSize: 14, fontWeight: "900" },
  messageBox: { borderRadius: 7, borderWidth: 1, padding: 10, marginTop: 12 },
  messageInfo: { backgroundColor: "#1e293b", borderColor: "#334155" },
  messageError: { backgroundColor: "#33151b", borderColor: "#7f1d1d" },
  messageSuccess: { backgroundColor: "#10291d", borderColor: "#166534" },
  messageText: { color: "#e2e8f0", fontSize: 12, lineHeight: 18, fontWeight: "700" },
  pendingHeader: { flexDirection: "row", justifyContent: "space-between", gap: 10, alignItems: "flex-start" },
  pendingTitleBlock: { flex: 1 },
  syncButton: { minHeight: 38, justifyContent: "center", borderWidth: 1, borderColor: "#334155", borderRadius: 7, paddingHorizontal: 12, backgroundColor: "#07111f" },
  syncButtonText: { color: "#7dd3fc", fontSize: 12, fontWeight: "900" },
  emptyText: { color: "#94a3b8", fontSize: 13, lineHeight: 19 },
  pendingItem: { borderTopWidth: 1, borderTopColor: "#243247", paddingTop: 10, marginTop: 10 },
  pendingTopRow: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  pendingTitle: { color: "#f8fafc", fontSize: 13, fontWeight: "900" },
  pendingStatus: { fontSize: 11, fontWeight: "900" },
  pendingDetail: { color: "#cbd5e1", fontSize: 12, lineHeight: 17, marginTop: 3 },
  pendingMeta: { color: "#94a3b8", fontSize: 11, marginTop: 3 },
  pendingError: { color: "#fecdd3", fontSize: 11, lineHeight: 16, marginTop: 4 },
});






