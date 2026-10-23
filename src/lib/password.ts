import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export function normalizeUsername(value: string) { return value.trim().toLowerCase(); }
export function validUsername(value: string) { return value.length >= 3 && value.length <= 254 && /^[a-z0-9._@+-]+$/.test(value); }
export function tokenHash(token: string) { return createHash("sha256").update(token).digest("hex"); }

export async function hashPassword(password: string) {
  if (password.length < 12 || Buffer.byteLength(password) > 256) {
    throw new Error("Mật khẩu cần ít nhất 12 ký tự và tối đa 256 byte.");
  }
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt);
  return `scrypt-v1$${salt}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [version, salt, key] = encoded.split("$");
  if (version !== "scrypt-v1" || !/^[a-f0-9]{32}$/.test(salt || "") || !/^[a-f0-9]{128}$/.test(key || "")) return false;
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, Buffer.from(key, "hex"));
}

// Keep unknown-user authentication on the same password-derivation path.
export const DUMMY_PASSWORD_HASH = `scrypt-v1$${"0".repeat(32)}$${"0".repeat(128)}`;
