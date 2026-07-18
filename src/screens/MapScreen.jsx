import * as Location from "expo-location";
import { WebView } from "react-native-webview";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { getCachedGisLayersForBbox, getCachedGisLayersForCenter, getCachedMaintenanceReports, getGisLayerCacheStats } from "../services/offlineStore";
import { syncGisLayerRows } from "../services/gisLayersService";
import { loadMaintenanceReports } from "../services/maintenanceReportsService";
import { loadMobileLocations, updateMobileLocation } from "../services/mobileLocationsService";

const DEFAULT_CENTER = { latitude: 16.4023, longitude: 120.5960 };
const EMPTY_FEATURE_COLLECTION = { type: "FeatureCollection", features: [] };
const FEEDER_COLORS = {
  FEEDER_01: "#FF6B6B", FEEDER_02: "#4D96FF", FEEDER_03: "#06D6A0", FEEDER_03A: "#FFD166",
  FEEDER_04: "#8338EC", FEEDER_05: "#EF476F", FEEDER_05A: "#118AB2", FEEDER_06: "#06A77D",
  FEEDER_07: "#8ECAE6", FEEDER_08: "#219EBC", FEEDER_09: "#023047", FEEDER_10: "#E76F51",
  FEEDER_11: "#2A9D8F", FEEDER_12: "#264653", FEEDER_14: "#2714fa", CIRCUIT_01: "#F72585",
  CIRCUIT_02: "#B5179E", CIRCUIT_03: "#7209B7", CIRCUIT_04: "#05f5ed", CIRCUIT_05: "#480CA8",
  CIRCUIT_06: "#f2a633", CIRCUIT_07: "#3F37C9", FEEDER_DALICNO: "#00B894", FEEDER_TAPSAN: "#D63031",
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

function normalizeFeatureCollection(value) {
  if (value?.type === "FeatureCollection" && Array.isArray(value.features)) return value;
  if (Array.isArray(value?.features)) return { type: "FeatureCollection", features: value.features };
  if (Array.isArray(value)) return { type: "FeatureCollection", features: value };
  return EMPTY_FEATURE_COLLECTION;
}

function normalizeGisLayerPayload(payload) {
  const sourceLayers = payload?.layers || payload || {};
  return { layers: GIS_LAYER_DEFINITIONS.reduce((acc, layer) => {
    acc[layer.key] = normalizeFeatureCollection(sourceLayers[layer.key]);
    return acc;
  }, {}) };
}

function safeScriptJson(value) {
  return JSON.stringify(value || {}).replace(/</g, "\\u003c");
}

function featureRows(payload) {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  return features.filter((feature) => feature?.geometry?.coordinates);
}

function buildMapHtml({ center, gisLayerPayload, gisLayerStats, maintenanceReports, mobileUsers }) {
  const lat = Number(center?.latitude) || DEFAULT_CENTER.latitude;
  const lon = Number(center?.longitude) || DEFAULT_CENTER.longitude;
  const gisLayersJson = safeScriptJson(normalizeGisLayerPayload(gisLayerPayload));
  const gisDefsJson = safeScriptJson(GIS_LAYER_DEFINITIONS);
  const feederColorsJson = safeScriptJson(FEEDER_COLORS);
  const statsJson = safeScriptJson(gisLayerStats || {});
  const maintenanceJson = safeScriptJson({ type: "FeatureCollection", features: featureRows(maintenanceReports) });
  const mobileUsersJson = safeScriptJson(mobileUsers || []);
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" /><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/ol@v10.6.1/ol.css"><style>
    html, body, #map { width: 100%; height: 100%; margin: 0; padding: 0; background: #07111f; } body { overflow: hidden; font-family: Arial, sans-serif; }
    .layer-switcher { position: absolute; top: 12px; left: 12px; z-index: 5; pointer-events: auto; }
    .layer-toggle, .icon { min-height: 42px; border: 1px solid rgba(148,163,184,.45); border-radius: 8px; padding: 0 12px; color: #e2e8f0; background: rgba(15,23,42,.92); font-size: 13px; font-weight: 900; box-shadow: 0 8px 22px rgba(2,6,23,.25); }
    .layer-toggle.active { color: #fff; border-color: #22c55e; background: rgba(15,139,76,.95); }
    .layer-panel { display: none; width: 250px; max-height: 70vh; overflow-y: auto; margin-top: 8px; border: 1px solid rgba(148,163,184,.38); border-radius: 9px; background: rgba(2,6,23,.92); color: #e2e8f0; }
    .layer-switcher.open .layer-panel { display: block; } .layer-section { padding: 10px; border-top: 1px solid rgba(148,163,184,.18); } .layer-section:first-child { border-top: 0; }
    .layer-heading { margin-bottom: 8px; color: #f8fafc; font-size: 11px; font-weight: 900; text-transform: uppercase; } .layer-option { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 5px 3px; font-size: 13px; font-weight: 800; }
    .layer-option input { width: 18px; height: 18px; accent-color: #16a34a; } .layer-count { margin-left: auto; color: #7dd3fc; font-size: 11px; font-weight: 900; } .layer-minzoom { color: #fbbf24; font-size: 10px; font-weight: 900; }
    .north-tool { position: absolute; top: 12px; right: 12px; z-index: 4; min-width: 42px; } .center-tool { position: absolute; right: 12px; bottom: 76px; z-index: 4; min-width: 42px; }
    #poleHtmlLayer { position: absolute; inset: 0; z-index: 3; pointer-events: none; overflow: hidden; } .pole-marker { position: absolute; width: 10.5px; height: 10.5px; border-radius: 50%; background: #00b400; border: 2.25px solid rgba(255,255,255,.95); box-shadow: 0 0 0 2.25px rgba(0,180,0,.25); transform: translate(-50%, -50%); pointer-events: none; }
    .pole-label { position: absolute; left: 50%; top: -20px; transform: translateX(-50%); color: #111827; background: rgba(255,255,255,.9); border-radius: 3px; padding: 1px 3px; font: 900 11px Arial, sans-serif; white-space: nowrap; }
  </style></head><body><div id="map"></div><div id="poleHtmlLayer"></div>
  <div class="layer-switcher" id="layerSwitcher"><button class="layer-toggle" id="layerToggle" type="button">Layers</button><div class="layer-panel" id="layerPanel"><div class="layer-section"><div class="layer-heading">Map Background</div><label class="layer-option"><input type="radio" name="basemap" value="googleHybrid" checked>Google Hybrid</label><label class="layer-option"><input type="radio" name="basemap" value="googleMap">Google Map</label><label class="layer-option"><input type="radio" name="basemap" value="osm">OpenStreetMap</label></div><div class="layer-section" id="overlayOptions"><div class="layer-heading">GIS Layers</div></div><div class="layer-section" id="fieldOptions"><div class="layer-heading">Field Layers</div></div></div></div>
  <button class="icon north-tool" id="northButton" type="button">N</button><button class="icon center-tool" id="centerButton" type="button">◎</button><script src="https://cdn.jsdelivr.net/npm/ol@v10.6.1/dist/ol.js"></script><script>
    const initialCoordinate = ol.proj.fromLonLat([${lon}, ${lat}]); const gisLayerPayload = ${gisLayersJson}; const gisLayerDefinitions = ${gisDefsJson}; const feederColors = ${feederColorsJson}; const gisLayerStats = ${statsJson}; const maintenanceReports = ${maintenanceJson}; const mobileUsers = ${mobileUsersJson}; const geoJsonFormat = new ol.format.GeoJSON();
    const sources = { googleHybrid: new ol.source.XYZ({ url:'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', maxZoom:22 }), googleMap: new ol.source.XYZ({ url:'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', maxZoom:22 }), osm: new ol.source.XYZ({ url:'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom:19 }) }; const baseLayer = new ol.layer.Tile({ source: sources.googleHybrid });
    function getFeatureValue(feature, names) { for (const name of names) { const value = feature.get(name); if (value !== undefined && value !== null && String(value).trim()) return value; } return ''; } function feederColor(feature, fallback) { const id = String(getFeatureValue(feature, ['feederid','feeder_id','feeder','FEEDERID','FEEDER'])).trim().toUpperCase(); return feederColors[id] || fallback; }
    function makeStyle(definition) { return function(feature) { const type = feature.getGeometry()?.getType?.() || ''; if (type.includes('Line')) return new ol.style.Style({ stroke: new ol.style.Stroke({ color: definition.feederColor ? feederColor(feature, definition.color) : definition.color, width: definition.width || 3 }) }); if (type.includes('Polygon')) return new ol.style.Style({ stroke: new ol.style.Stroke({ color: definition.color, width: 2 }), fill: new ol.style.Fill({ color: definition.color + '33' }) }); return new ol.style.Style({ image: new ol.style.Circle({ radius: definition.radius || 5, fill: new ol.style.Fill({ color: definition.color }), stroke: new ol.style.Stroke({ color: '#fff', width: 1.5 }) }) }); }; }
    const gisLayers = {}; gisLayerDefinitions.forEach(function(definition) { const source = new ol.source.Vector({ features: geoJsonFormat.readFeatures(gisLayerPayload.layers?.[definition.key] || { type:'FeatureCollection', features:[] }, { featureProjection:'EPSG:3857' }) }); gisLayers[definition.key] = new ol.layer.Vector({ source, style: makeStyle(definition), visible: Boolean(definition.visible), zIndex: definition.key === 'poles' ? 45 : definition.geometry === 'line' ? 20 : 35 }); });
    const maintenanceTypeThemeMap = { pole:{color:'#b45309',abbrev:'P'}, primarylines:{color:'#f97316',abbrev:'PL'}, secondarylines:{color:'#fbbf24',abbrev:'SL'}, servicedrop:{color:'#65a30d',abbrev:'SD'}, transformer:{color:'#2563eb',abbrev:'T'}, rowclearing:{color:'#15803d',abbrev:'RC'}, streetlight:{color:'#6d28d9',abbrev:'ST'}, communicationcables:{color:'#0ea5e9',abbrev:'CC'}, meter:{color:'#ec4899',abbrev:'M'}, others:{color:'#6b7280',abbrev:'O'}, default:{color:'#64748b',abbrev:'MO'} };
    const maintenanceStyleCache = {};
    function normalizeMaintenanceReportType(value){ return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, ''); }
    function escapeSvgText(value){ return String(value || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;'); }
    function isMaintenanceClosed(value){ const status = String(value || '').trim().toUpperCase(); return status === 'CLOSED' || status === 'CLOSE'; }
    function getMaintenanceTypeTheme(reportType){ const key = normalizeMaintenanceReportType(reportType); return maintenanceTypeThemeMap[key] || maintenanceTypeThemeMap.default; }
    function buildMaintenanceMarkerSvg(reportType, closed){ const theme = getMaintenanceTypeTheme(reportType); const fill = closed ? theme.color + 'E6' : theme.color; const stroke = closed ? '#1f2937' : '#ffffff'; const abbrev = escapeSvgText(theme.abbrev || 'MO'); return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 128" width="96" height="128"><defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000000" flood-opacity="0.28"/></filter></defs><ellipse cx="48" cy="121" rx="16" ry="4" fill="rgba(0,0,0,0.22)"/><path d="M48 8C30.4 8 16 22.4 16 40c0 23.1 18.3 44.7 32 65.9C61.7 84.7 80 63.1 80 40c0-17.6-14.4-32-32-32Z" fill="'+fill+'" stroke="'+stroke+'" stroke-width="2.5" filter="url(#shadow)"/><circle cx="48" cy="40" r="22" fill="#ffffff" opacity="0.98" stroke="'+stroke+'" stroke-width="2"/><circle cx="48" cy="40" r="16" fill="'+fill+'" opacity="0.16"/><text x="48" y="46" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="700" fill="#111827">'+abbrev+'</text></svg>'; }
    function getMaintenanceMarkerStyle(reportType, closed){ const key = normalizeMaintenanceReportType(reportType) + '|' + (closed ? 'closed' : 'open'); if(!maintenanceStyleCache[key]) maintenanceStyleCache[key] = new ol.style.Style({ image: new ol.style.Icon({ src:'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(buildMaintenanceMarkerSvg(reportType, closed)), scale: closed ? 0.42 : 0.46, anchor:[0.5,1], anchorXUnits:'fraction', anchorYUnits:'fraction' }) }); return maintenanceStyleCache[key]; }
    function buildMaintenanceStyle(feature){ const reportType = String(feature.get('report_type') || '').trim(); const closed = isMaintenanceClosed(feature.get('status')); const label = String(feature.get('label') || feature.get('report_desc') || '').trim(); const styles = [getMaintenanceMarkerStyle(reportType, closed)]; if(label){ styles.push(new ol.style.Style({ text: new ol.style.Text({ text: label, font:'bold 11px Arial', fill:new ol.style.Fill({ color:'#ffffff' }), stroke:new ol.style.Stroke({ color:'#111827', width:3 }), offsetY:-18, overflow:true }) })); } return styles; }
    const maintenanceLayer = new ol.layer.Vector({ source: new ol.source.Vector({ features: geoJsonFormat.readFeatures(maintenanceReports, { featureProjection:'EPSG:3857' }) }), visible: true, zIndex: 70, style: buildMaintenanceStyle });
    const usersLayer = new ol.layer.Vector({ source: new ol.source.Vector({ features: mobileUsers.map(function(user) { return new ol.Feature({ geometry: new ol.geom.Point(ol.proj.fromLonLat([Number(user.longitude), Number(user.latitude)])), name: user.fullName || user.username || 'Mobile user' }); }) }), visible: true, zIndex: 80, style: function(feature) { return new ol.style.Style({ image: new ol.style.Circle({ radius: 7, fill: new ol.style.Fill({ color:'#38bdf8' }), stroke: new ol.style.Stroke({ color:'#fff', width:2 }) }), text: new ol.style.Text({ text: String(feature.get('name') || ''), offsetY: -16, font:'bold 11px Arial', fill: new ol.style.Fill({ color:'#0f172a' }), stroke: new ol.style.Stroke({ color:'#fff', width:3 }) }) }); } });
    const view = new ol.View({ center: initialCoordinate, zoom: 17, maxZoom: 22, enableRotation: true }); const map = new ol.Map({ target:'map', layers:[baseLayer].concat(Object.values(gisLayers), [maintenanceLayer, usersLayer]), view, controls: ol.control.defaults.defaults({ rotate:false }) });
    function stop(e){ e.stopPropagation(); } function bindTap(el, fn){ let touched=0; el.addEventListener('pointerdown', stop); el.addEventListener('touchstart', stop, {passive:true}); el.addEventListener('touchend', function(e){ touched=Date.now(); e.preventDefault(); e.stopPropagation(); fn(e); }, {passive:false}); el.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation(); if (Date.now()-touched>450) fn(e); }); }
    ['layerSwitcher','layerPanel'].forEach(function(id){ const el=document.getElementById(id); el.addEventListener('pointerdown', stop); el.addEventListener('touchstart', stop, {passive:true}); el.addEventListener('click', stop); }); bindTap(document.getElementById('layerToggle'), function(){ const sw=document.getElementById('layerSwitcher'); sw.classList.toggle('open'); document.getElementById('layerToggle').classList.toggle('active', sw.classList.contains('open')); }); bindTap(document.getElementById('northButton'), function(){ view.animate({ rotation:0, duration:220 }); }); bindTap(document.getElementById('centerButton'), function(){ view.animate({ center: initialCoordinate, zoom: Math.max(view.getZoom() || 17, 17), duration:250 }); }); document.querySelectorAll('input[name="basemap"]').forEach(function(input){ input.addEventListener('change', function(){ if (input.checked) baseLayer.setSource(sources[input.value]); }); });
    const layerInputs = {}, layerCounts = {}, layerRows = {}; function getPoleCoordinates(feature){ const g=feature?.getGeometry?.(); if(!g) return []; const t=g.getType?.(); if(t==='Point') return [g.getCoordinates()]; if(t==='MultiPoint') return g.getCoordinates(); return []; } function syncPoleOverlays(){ const box=document.getElementById('poleHtmlLayer'); if(!box) return; box.innerHTML=''; const def=gisLayerDefinitions.find(function(d){return d.key==='poles'}); const input=layerInputs.poles; const zoom=view.getZoom()||0; if(!def || !input?.checked || zoom < def.minZoom) return; const size=map.getSize(); gisLayers.poles?.getSource?.().getFeatures().forEach(function(feature){ const label=getFeatureValue(feature, ['nodeid','NODEID','node_id','poleid','POLEID']); getPoleCoordinates(feature).forEach(function(coord){ const pixel=map.getPixelFromCoordinate(coord); if(!pixel || pixel[0]<-40 || pixel[1]<-40 || pixel[0]>size[0]+40 || pixel[1]>size[1]+40) return; const marker=document.createElement('div'); marker.className='pole-marker'; marker.style.left=pixel[0]+'px'; marker.style.top=pixel[1]+'px'; if(label){ const span=document.createElement('span'); span.className='pole-label'; span.textContent=String(label); marker.appendChild(span); } box.appendChild(marker); }); }); }
    function setLayerCount(def){ const count=gisLayers[def.key]?.getSource?.().getFeatures().length || 0; const total=Number(gisLayerStats?.[def.key]?.count || 0); if(layerCounts[def.key]) layerCounts[def.key].textContent = total ? String(count)+' / '+String(total) : String(count); } function applyVisibility(){ const zoom=view.getZoom()||0; gisLayerDefinitions.forEach(function(def){ const input=layerInputs[def.key]; const allowed=!def.minZoom || zoom>=def.minZoom; gisLayers[def.key].setVisible(Boolean(input?.checked && allowed)); if(layerRows[def.key]) layerRows[def.key].classList.toggle('scale-hidden', !allowed); }); syncPoleOverlays(); }
    function addOption(parent, labelText, checked, countText, onChange){ const label=document.createElement('label'); label.className='layer-option'; const input=document.createElement('input'); input.type='checkbox'; input.checked=checked; const text=document.createTextNode(labelText); const count=document.createElement('span'); count.className='layer-count'; count.textContent=countText || ''; label.appendChild(input); label.appendChild(text); label.appendChild(count); parent.appendChild(label); input.addEventListener('change', function(e){ e.stopPropagation(); onChange(input); }); label.addEventListener('click', stop); return { label, input, count }; }
    const overlayOptions=document.getElementById('overlayOptions'); gisLayerDefinitions.forEach(function(def){ const item=addOption(overlayOptions, def.label, Boolean(def.visible), '', function(input){ if(input.checked && def.minZoom && (view.getZoom()||0)<def.minZoom) view.animate({ zoom:def.minZoom+.2, duration:300 }); applyVisibility(); }); layerInputs[def.key]=item.input; layerCounts[def.key]=item.count; layerRows[def.key]=item.label; if(def.minZoom){ const z=document.createElement('span'); z.className='layer-minzoom'; z.textContent=def.minZoom+'+'; item.label.insertBefore(z, item.count); } setLayerCount(def); }); const fieldOptions=document.getElementById('fieldOptions'); addOption(fieldOptions, 'Maintenance Orders', true, String(maintenanceLayer.getSource().getFeatures().length), function(input){ maintenanceLayer.setVisible(input.checked); }); addOption(fieldOptions, 'Mobile Users', true, String(usersLayer.getSource().getFeatures().length), function(input){ usersLayer.setVisible(input.checked); });
    function maintenanceFeatureToReport(feature){ const props={}; feature.getKeys().forEach(function(key){ if(key !== 'geometry') props[key]=feature.get(key); }); const geometry=feature.getGeometry(); const coord=geometry?.getType?.()==='Point' ? ol.proj.toLonLat(geometry.getCoordinates()) : []; props.id=props.id || props.mo_id; props.lon=props.lon ?? coord[0]; props.lat=props.lat ?? coord[1]; props.reportType=props.report_type; props.reportDesc=props.report_desc; props.eventTime=props.event_time; props.endorsedTo=props.endorsed_to; props.visibleOn=props.visible_on; return props; }
    map.on('singleclick', function(event){ let found=null; map.forEachFeatureAtPixel(event.pixel, function(feature, layer){ if(layer === maintenanceLayer){ found=feature; return true; } return false; }, { hitTolerance: 12 }); if(found){ window.ReactNativeWebView.postMessage(JSON.stringify({ type:'openMaintenanceReport', report: maintenanceFeatureToReport(found) })); } });
    function requestLayers(){ const size=map.getSize(); if(!size) return; const ex=view.calculateExtent(size); const bl=ol.proj.toLonLat([ex[0],ex[1]]); const tr=ol.proj.toLonLat([ex[2],ex[3]]); window.ReactNativeWebView.postMessage(JSON.stringify({ type:'requestGisLayers', bounds:{ minLon:bl[0], minLat:bl[1], maxLon:tr[0], maxLat:tr[1] } })); } let timer=null; function schedule(){ clearTimeout(timer); timer=setTimeout(requestLayers,260); } window.updateGisLayers=function(payload){ const next=payload?.layers || {}; gisLayerDefinitions.forEach(function(def){ const src=gisLayers[def.key]?.getSource?.(); if(!src) return; src.clear(true); src.addFeatures(geoJsonFormat.readFeatures(next[def.key] || { type:'FeatureCollection', features:[] }, { featureProjection:'EPSG:3857' })); setLayerCount(def); }); applyVisibility(); }; view.on('change:resolution', applyVisibility); map.on('moveend', function(){ schedule(); syncPoleOverlays(); }); applyVisibility(); setTimeout(schedule,450);
  </script></body></html>`;
}

export default function MapScreen({ token, onOpenMaintenanceReport, onSyncStatusChange }) {
  const webViewRef = useRef(null);
  const [center, setCenter] = useState(DEFAULT_CENTER);
  const [gisLayers, setGisLayers] = useState(() => normalizeGisLayerPayload(null));
  const [gisStats, setGisStats] = useState({});
  const [maintenanceReports, setMaintenanceReports] = useState(EMPTY_FEATURE_COLLECTION);
  const [mobileUsers, setMobileUsers] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("Preparing map...");

  const mapHtml = useMemo(
    () => buildMapHtml({ center, gisLayerPayload: gisLayers, gisLayerStats: gisStats, maintenanceReports, mobileUsers }),
    [center, gisLayers, gisStats, maintenanceReports, mobileUsers]
  );
  const webViewSource = useMemo(() => ({ html: mapHtml }), [mapHtml]);

  const refreshLocationAndUsers = useCallback(async () => {
    let nextCenter = center;
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status === "granted") {
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        nextCenter = { latitude: Number(pos.coords.latitude.toFixed(6)), longitude: Number(pos.coords.longitude.toFixed(6)) };
        setCenter(nextCenter);
        await updateMobileLocation({ token, latitude: nextCenter.latitude, longitude: nextCenter.longitude, accuracy: pos.coords.accuracy });
      }
    } catch {}
    try {
      const users = await loadMobileLocations({ token, minutes: 30 });
      setMobileUsers(users);
    } catch {
      setMobileUsers([]);
    }
    return nextCenter;
  }, [center, token]);

  const loadMapData = useCallback(async () => {
    const nextCenter = await refreshLocationAndUsers();
    const layerKeys = GIS_LAYER_DEFINITIONS.map((layer) => layer.key);
    const [nearbyLayers, cacheStats, cachedReports] = await Promise.all([
      getCachedGisLayersForCenter(nextCenter, 0.04, layerKeys),
      getGisLayerCacheStats(layerKeys),
      getCachedMaintenanceReports(),
    ]);
    setGisLayers(normalizeGisLayerPayload(nearbyLayers));
    setGisStats(cacheStats);
    setMaintenanceReports(cachedReports?.payload || EMPTY_FEATURE_COLLECTION);
    setMessage("Map ready.");
  }, [refreshLocationAndUsers]);

  useEffect(() => {
    loadMapData();
    const timer = setInterval(refreshLocationAndUsers, 60000);
    return () => clearInterval(timer);
  }, [loadMapData, refreshLocationAndUsers]);

  async function handleMapMessage(event) {
    try {
      const msg = JSON.parse(event?.nativeEvent?.data || "{}");
      if (msg?.type === "openMaintenanceReport") {
        onOpenMaintenanceReport?.(msg.report);
        return;
      }
      if (msg?.type !== "requestGisLayers") return;
      const payload = normalizeGisLayerPayload(await getCachedGisLayersForBbox(msg.bounds, GIS_LAYER_DEFINITIONS.map((layer) => layer.key)));
      webViewRef.current?.injectJavaScript(`window.updateGisLayers && window.updateGisLayers(${safeScriptJson(payload)}); true;`);
    } catch {}
  }

  async function handleSyncGis() {
    setSyncing(true);
    setMessage("Syncing GIS layers...");
    try {
      let last = "";
      const results = await syncGisLayerRows({ token, layerKeys: ["poles", "primarylines", "secondarylines", "transformers", "fco", "recloser", "lbs", "ds"], onLayerSynced: (entry) => {
        last = `${entry.label}: ${entry.saved}${entry.received ? ` / ${entry.received}` : ""}`;
        setMessage(last);
      } });
      const reports = await loadMaintenanceReports({ token });
      onSyncStatusChange?.(reports);
      await loadMapData();
      const poleResult = results.find((entry) => entry.key === "poles");
      setMessage(poleResult ? `GIS synced. Poles cached ${poleResult.saved} / ${poleResult.received || poleResult.saved}.` : "GIS layers synced.");
    } catch (error) {
      setMessage(error?.message || "GIS sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.toolbar}>
        <View style={styles.toolbarText}>
          <Text style={styles.title}>Field Map</Text>
          <Text style={styles.message} numberOfLines={1}>{message}</Text>
        </View>
        <Pressable onPress={handleSyncGis} disabled={syncing} style={[styles.syncButton, syncing && styles.disabledButton]}>
          {syncing ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.syncText}>Sync GIS</Text>}
        </Pressable>
      </View>
      <WebView ref={webViewRef} originWhitelist={["*"]} source={webViewSource} style={styles.map} javaScriptEnabled domStorageEnabled onMessage={handleMapMessage} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: "#07111f" },
  toolbar: { minHeight: 68, paddingHorizontal: 12, paddingVertical: 9, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, backgroundColor: "#0b1424", borderBottomWidth: 1, borderBottomColor: "#1e293b" },
  toolbarText: { flex: 1, minWidth: 0 },
  title: { color: "#f8fafc", fontSize: 16, fontWeight: "900" },
  message: { color: "#94a3b8", fontSize: 12, marginTop: 3, fontWeight: "700" },
  syncButton: { minHeight: 42, minWidth: 92, borderRadius: 7, backgroundColor: "#0f8b4c", borderWidth: 1, borderColor: "#22c55e", alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  disabledButton: { opacity: 0.72 },
  syncText: { color: "#ffffff", fontSize: 12, fontWeight: "900" },
  map: { flex: 1, width: "100%", height: "100%" },
});
