export class InputError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("Dữ liệu không hợp lệ.");
  return value as Record<string, unknown>;
}
export function id(value: unknown) {
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > BigInt("18446744073709551615")) throw new InputError("Mã bản ghi không hợp lệ.");
  return value;
}
