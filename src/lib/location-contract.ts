import { InputError } from "./validation";

// Trim outer whitespace only. Case/leading zeros are meaningful until verified
// against Nemo's successful-login contract; never coerce usernames to numbers.
export function parseEmployeeUsername(value: unknown, optional = false): string {
  if (optional && (value === null || value === "")) return "";
  if (typeof value !== "string") throw new InputError("Tên đăng nhập Nemo không hợp lệ.");
  const result = value.trim();
  if ((!optional && !result) || Array.from(result).length > 120 || /[\u0000-\u001f\u007f]/.test(result)) throw new InputError("Tên đăng nhập Nemo cần 1–120 ký tự hợp lệ.");
  return result;
}

export type LocationCenter = { hospitalId: string; latitude: number; longitude: number; radiusMeters: number };
export function parseCenters(value: unknown): LocationCenter[] {
  if (!Array.isArray(value) || value.length > 100) throw new InputError("Cần danh sách tối đa 100 địa điểm.");
  const seen = new Set<string>();
  return value.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new InputError("Địa điểm không hợp lệ.");
    const { hospitalId, latitude, longitude, radiusMeters } = row;
    if (typeof hospitalId !== "string" || !/^[0-9]{1,20}$/.test(hospitalId) || seen.has(hospitalId)) throw new InputError("ID địa điểm thiếu, trùng hoặc không hợp lệ.");
    if (typeof latitude !== "number" || !Number.isFinite(latitude) || Math.abs(latitude) > 90 || typeof longitude !== "number" || !Number.isFinite(longitude) || Math.abs(longitude) > 180) throw new InputError("Tọa độ tâm không hợp lệ.");
    if (typeof radiusMeters !== "number" || !Number.isFinite(radiusMeters) || radiusMeters <= 0 || radiusMeters > 120) throw new InputError("Bán kính phải lớn hơn 0 và không vượt 120 m.");
    seen.add(hospitalId);
    return { hospitalId, latitude, longitude, radiusMeters };
  });
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function parseLocationRequest(value: Record<string, unknown>) {
  if (Object.keys(value).some(k => !["requestId", "sessionId", "action", "hospitalId", "employeeUsername"].includes(k))) throw new InputError("Request có trường không hỗ trợ.");
  const { requestId, sessionId, action, hospitalId } = value;
  if (typeof requestId !== "string" || !uuid.test(requestId) || typeof sessionId !== "string" || !uuid.test(sessionId)
    || (action !== "start" && action !== "end") || typeof hospitalId !== "string" || !/^[0-9]{1,20}$/.test(hospitalId)) throw new InputError("Context vị trí không hợp lệ.");
  return { requestId, sessionId, action, hospitalId, employeeUsername: parseEmployeeUsername(value.employeeUsername) };
}

export function locationProofMessage(timestamp: string, rawBody: string) {
  return `nemo-location-context-v1\nPOST\n/api/v1/location-context\n${timestamp}\n${rawBody}`;
}

export function locationPilotLicense(env: Record<string, string | undefined>): string | null {
  const pilot = env.LOCATION_CONTEXT_PILOT_LICENSE_ID;
  return env.LOCATION_CONTEXT_ENABLED === "true" && pilot && /^[1-9]\d{0,19}$/.test(pilot)
    && BigInt(pilot) <= BigInt("18446744073709551615") ? pilot : null;
}
