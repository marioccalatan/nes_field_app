import { API_ENDPOINTS } from "../config/api";

export async function updateMobileLocation({ token, latitude, longitude, accuracy } = {}) {
  const response = await fetch(API_ENDPOINTS.mobileLocations, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify({ lat: latitude, lon: longitude, accuracy }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) throw new Error(data?.message || "Failed to update location.");
  return data.location;
}

export async function loadMobileLocations({ token, minutes = 30 } = {}) {
  const url = API_ENDPOINTS.mobileLocations + "?minutes=" + encodeURIComponent(String(minutes));
  const response = await fetch(url, {
    headers: token ? { Authorization: "Bearer " + token } : {},
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) throw new Error(data?.message || "Failed to load mobile users.");
  return Array.isArray(data.users) ? data.users : [];
}
