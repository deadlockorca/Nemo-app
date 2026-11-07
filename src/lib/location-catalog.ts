import catalog from "../../data/nemo-locations-web.json";
import { distanceMeters, type Coordinate } from "./location-random";

export type LocationOption = Coordinate & { code: string; name: string; sourceCodes: string[] };

// Only the fields needed by the public tool are passed to the browser.
export const locationOptions: LocationOption[] = catalog.locations.map(location => {
  if (!location.lat.trim() || !location.long.trim()) throw new Error(`Missing coordinates: ${location.code}`);
  const option = {
    code: location.code,
    name: location.name,
    sourceCodes: location.source_codes,
    latitude: Number(location.lat),
    longitude: Number(location.long),
  };
  distanceMeters(option, option); // Validate finite values and geographic bounds at build time.
  return option;
});
if (locationOptions.length !== catalog.location_count || new Set(locationOptions.map(p => p.code)).size !== locationOptions.length) {
  throw new Error("Invalid location catalog count or duplicate codes");
}
