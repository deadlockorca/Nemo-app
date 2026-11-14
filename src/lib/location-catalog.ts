import "server-only";
import catalog12436899 from "../../data/location-catalogs/12436899.json";
import { parseCenters } from "./location-contract";

export function locationCatalog(employeeUsername: string | null) {
  // Exact account match; never suggest another customer's catalog.
  if (employeeUsername !== catalog12436899.employeeUsername) return null;
  const centers = parseCenters(catalog12436899.centers);
  return { label: catalog12436899.label, missingCoordinates: catalog12436899.missingCoordinates,
    centers: centers.map((center, index) => ({ ...center, name: catalog12436899.centers[index].name })) };
}
