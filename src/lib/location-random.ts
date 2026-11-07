export type Coordinate = { latitude: number; longitude: number };
export type GeneratedCoordinate = Coordinate & { distanceMeters: number; bearingDegrees: number };

export const LOCATION_LIMIT_METERS = 150;
// Keep a margin for coordinate rounding and differences between distance models.
export const SAMPLING_RADIUS_METERS = 149;
const EARTH_RADIUS_METERS = 6_371_008.8;
const radians = (degrees: number) => degrees * Math.PI / 180;
const degrees = (angle: number) => angle * 180 / Math.PI;

function validateCoordinate(point: Coordinate) {
  if (!Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90 ||
      !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180) {
    throw new RangeError("Tọa độ địa điểm không hợp lệ.");
  }
}

export function distanceMeters(from: Coordinate, to: Coordinate): number {
  validateCoordinate(from);
  validateCoordinate(to);
  const deltaLatitude = radians(to.latitude - from.latitude);
  const deltaLongitude = radians(to.longitude - from.longitude);
  const a = Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

/** Sample a disk by area, project onto Earth, then validate the rounded output. */
export function generateNearbyCoordinate(center: Coordinate, random: () => number = Math.random): GeneratedCoordinate {
  validateCoordinate(center);
  const radialSample = random(), angularSample = random();
  if (![radialSample, angularSample].every(value => Number.isFinite(value) && value >= 0 && value < 1)) {
    throw new RangeError("Nguồn ngẫu nhiên không hợp lệ.");
  }
  const arc = SAMPLING_RADIUS_METERS * Math.sqrt(radialSample) / EARTH_RADIUS_METERS;
  const bearing = 2 * Math.PI * angularSample;
  const latitude = radians(center.latitude), longitude = radians(center.longitude);
  // Rotate a local north/east displacement in 3D, including at either pole.
  const north = Math.sin(arc) * Math.cos(bearing);
  const east = Math.sin(arc) * Math.sin(bearing);
  const radial = Math.cos(latitude) * Math.cos(arc) - Math.sin(latitude) * north;
  const x = radial * Math.cos(longitude) - east * Math.sin(longitude);
  const y = radial * Math.sin(longitude) + east * Math.cos(longitude);
  const z = Math.sin(latitude) * Math.cos(arc) + Math.cos(latitude) * north;
  const point = {
    latitude: Number(degrees(Math.atan2(z, Math.hypot(x, y))).toFixed(7)),
    longitude: Number(degrees(Math.atan2(y, x)).toFixed(7)),
  };
  const distance = distanceMeters(center, point);
  if (!Number.isFinite(distance) || distance >= LOCATION_LIMIT_METERS) {
    throw new RangeError("Chưa tạo được tọa độ trong phạm vi. Vui lòng thử lại.");
  }
  return { ...point, distanceMeters: distance, bearingDegrees: degrees(bearing) };
}

export function normalizeLocationSearch(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d").toLowerCase().trim();
}
