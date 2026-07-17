import { API_ENDPOINTS } from "../config/api";
import { saveGisLayerFeatures } from "./offlineStore";

export const GIS_SYNC_LAYERS = [
  { key: "poles", label: "Poles", endpoint: API_ENDPOINTS.gisPoles },
  { key: "primarylines", label: "Primary Line", endpoint: API_ENDPOINTS.gisPrimary },
  { key: "secondarylines", label: "Secondary Lines", endpoint: API_ENDPOINTS.gisSecondary },
  { key: "transformers", label: "Transformers", endpoint: API_ENDPOINTS.gisTransformers },
  { key: "fco", label: "FCO", endpoint: API_ENDPOINTS.gisFco },
  { key: "recloser", label: "Recloser", endpoint: API_ENDPOINTS.gisRecloser },
  { key: "ds", label: "DS", endpoint: API_ENDPOINTS.gisDs },
  { key: "lbs", label: "LBS", endpoint: API_ENDPOINTS.gisLbs },
];

export async function syncGisLayerRows({ token, onLayerSynced, layerKeys } = {}) {
  const selectedKeys = Array.isArray(layerKeys) && layerKeys.length ? new Set(layerKeys) : null;
  const layersToSync = selectedKeys ? GIS_SYNC_LAYERS.filter((layer) => selectedKeys.has(layer.key)) : GIS_SYNC_LAYERS;
  const results = [];
  for (const layer of layersToSync) {
    const response = await fetch(layer.endpoint, {
      cache: "no-store",
      headers: token ? { Authorization: "Bearer " + token } : {},
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) throw new Error("Failed to sync " + layer.label + ".");
    const result = await saveGisLayerFeatures(layer.key, data);
    const entry = { ...layer, ...result };
    results.push(entry);
    onLayerSynced?.(entry);
  }
  return results;
}
