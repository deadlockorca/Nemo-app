import { test } from "node:test";
import assert from "node:assert/strict";
import { locationOptions } from "../src/lib/location-catalog";
import { distanceMeters, generateNearbyCoordinate, normalizeLocationSearch } from "../src/lib/location-random";

function seededRandom() {
  let seed = 73421;
  return () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 2 ** 32; };
}

test("catalog retains 48 source codes across 47 display locations and the requested merge", () => {
  assert.equal(locationOptions.length, 47);
  assert.equal(new Set(locationOptions.flatMap(p => p.sourceCodes)).size, 48);
  const merged = locationOptions.filter(p => p.sourceCodes.includes("752004472") || p.sourceCodes.includes("ACC1106"));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, "Phòng khám Nhi khoa – BS Nguyễn Tiến Dũng");
  assert.equal(merged[0].latitude, 20.989899);
  assert.equal(merged[0].longitude, 105.839063);
  assert.equal(normalizeLocationSearch(merged[0].name).includes("nguyen tien dung"), true);
  assert.equal(normalizeLocationSearch("  ĐỐNG ĐA "), "dong da");
});

test("distance uses meters and handles the date line", () => {
  assert.equal(distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 }), 0);
  assert.ok(Math.abs(distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }) - 111195.08) < .02);
  assert.ok(distanceMeters({ latitude: 0, longitude: 179.9999 }, { latitude: 0, longitude: -179.9999 }) < 23);
});

test("rounded outputs for every actual location stay strictly inside 150 m", () => {
  const random = seededRandom();
  for (const location of locationOptions) {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const result = generateNearbyCoordinate(location, random);
      assert.ok(result.distanceMeters >= 0 && result.distanceMeters < 150);
      // Independent local WGS84 metric, rather than only checking our Haversine function.
      const phi = location.latitude * Math.PI / 180;
      const eccentricitySquared = 0.00669437999014;
      const denominator = 1 - eccentricitySquared * Math.sin(phi) ** 2;
      const northRadius = 6378137 * (1 - eccentricitySquared) / denominator ** 1.5;
      const eastRadius = 6378137 / Math.sqrt(denominator);
      const north = (result.latitude - location.latitude) * Math.PI / 180 * northRadius;
      const east = (result.longitude - location.longitude) * Math.PI / 180 * eastRadius * Math.cos(phi);
      assert.ok(Math.hypot(north, east) < 150);
      assert.equal(Number(result.latitude.toFixed(7)), result.latitude);
      assert.equal(Number(result.longitude.toFixed(7)), result.longitude);
      seen.add(`${result.latitude},${result.longitude}`);
    }
    assert.ok(seen.size > 290);
  }
});

test("extreme samples, poles and date-line crossings remain finite and inside the radius", () => {
  for (const center of [{ latitude: 90, longitude: 180 }, { latitude: -90, longitude: -180 }, { latitude: 0, longitude: 179.9999999 }, ...locationOptions]) {
    for (const radius of [0, .25, 1 - Number.EPSILON]) {
      for (const bearing of [0, .25, .5, .75, 1 - Number.EPSILON]) {
        const values = [radius, bearing];
        const result = generateNearbyCoordinate(center, () => values.shift()!);
        assert.ok(Number.isFinite(result.latitude) && Math.abs(result.latitude) <= 90);
        assert.ok(Number.isFinite(result.longitude) && Math.abs(result.longitude) <= 180);
        assert.ok(result.distanceMeters < 150);
      }
    }
  }
});

test("sampling spreads points by area instead of concentrating them near the center", () => {
  const random = seededRandom();
  let innerHalf = 0;
  const quadrants = [0, 0, 0, 0];
  for (let i = 0; i < 8000; i++) {
    const result = generateNearbyCoordinate(locationOptions[0], random);
    if (result.distanceMeters < 74.5) innerHalf++;
    quadrants[Math.floor(result.bearingDegrees / 90)]++;
  }
  assert.ok(innerHalf > 1800 && innerHalf < 2200);
  for (const count of quadrants) assert.ok(count > 1800 && count < 2200);
});

test("invalid centers and random values are rejected", () => {
  for (const center of [{ latitude: NaN, longitude: 0 }, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: Infinity }, { latitude: 0, longitude: -181 }]) {
    assert.throws(() => generateNearbyCoordinate(center), RangeError);
  }
  for (const value of [NaN, Infinity, -1, 1]) {
    assert.throws(() => generateNearbyCoordinate(locationOptions[0], () => value), RangeError);
  }
});
