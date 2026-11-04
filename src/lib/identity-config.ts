// Shared shape agreed with Nemo-Blank-v1. No customer values or defaults.
export type IdentityConfig = { v: 1; device_id: string; uuid: string };

export function parseIdentityConfig(value: unknown): IdentityConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Cần đủ Device ID và UUID đăng ký.");
  const c = value as Record<string, unknown>;
  if (c.v !== 1 || typeof c.device_id !== "string" || !/^[0-9A-F]{8}-(?:[0-9A-F]{4}-){3}[0-9A-F]{12}$/.test(c.device_id)) {
    throw new Error("Device ID phải là UUID 36 ký tự viết hoa, có dấu gạch ngang.");
  }
  if (typeof c.uuid !== "string" || !/^[a-fA-F0-9]{64}$/.test(c.uuid)) throw new Error("UUID đăng ký phải gồm đúng 64 ký tự hexadecimal.");
  return { v: 1, device_id: c.device_id, uuid: c.uuid };
}
