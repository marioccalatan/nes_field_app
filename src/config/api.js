export const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || "http://116.50.169.136:4000";

export const API_ENDPOINTS = {
  login: `${API_BASE_URL}/api/auth/login`,
  health: `${API_BASE_URL}/api/health`,
  maintenanceReports: `${API_BASE_URL}/api/gis/maintenance-reports`,
  mobileLocations: `${API_BASE_URL}/api/gis/mobile-locations`,
  maintenanceReportTypes: `${API_BASE_URL}/api/gis/maintenance-reports/lookups/report-types`,
  maintenanceReportDescriptions: `${API_BASE_URL}/api/gis/maintenance-reports/lookups/report-descriptions`,
  maintenanceEndorsementUsers: `${API_BASE_URL}/api/gis/maintenance-reports/lookups/endorsement-users`,
  municipalities: `${API_BASE_URL}/api/gis/damage-reports/lookups/municipalities`,
  barangays: `${API_BASE_URL}/api/gis/damage-reports/lookups/barangays`,
  feeders: `${API_BASE_URL}/api/gis/damage-reports/lookups/feeders`,
  gisPrimary: `${API_BASE_URL}/api/gis/primary`,
  gisPoles: `${API_BASE_URL}/api/gis/poles`,
  gisSecondary: `${API_BASE_URL}/api/gis/secondary`,
  gisTransformers: `${API_BASE_URL}/api/gis/transformers`,
  gisFco: `${API_BASE_URL}/api/gis/fco`,
  gisRecloser: `${API_BASE_URL}/api/gis/recloser`,
  gisDs: `${API_BASE_URL}/api/gis/ds`,
  gisLbs: `${API_BASE_URL}/api/gis/lbs`,
};
