import { createPrivateKey, createPublicKey, createHash, sign, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseIdentityConfig, type IdentityConfig } from "./identity-config";

export const LEASE_SECONDS = 24 * 60 * 60;
export const LICENSE_ISSUER = "nemo-license";
export const LICENSE_AUDIENCE = "nemo-app";
export type LeaseClaims = {
  v: 1; iss: string; aud: string; sub: string; device: string; version: number;
  iat: number; exp: number; licenseExpiresAt: number; nonce?: string; identity?: IdentityConfig;
};
function hash(value: Buffer) { return createHash("sha256").update(value).digest("hex"); }
export function publicIdentity(base64: string) {
  if (!/^[A-Za-z0-9+/]{59}=$/.test(base64)) throw new Error("Invalid Ed25519 SPKI public key");
  const der = Buffer.from(base64, "base64");
  if (der.length !== 44 || der.toString("base64") !== base64) throw new Error("Invalid public key encoding");
  const publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Expected Ed25519");
  const canonical = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  if (!canonical.equals(der)) throw new Error("Noncanonical public key");
  return { publicKey, base64, fingerprint: hash(der) };
}
export function signingIdentity() {
  const path = process.env.LICENSE_PRIVATE_KEY_FILE;
  if (!path) throw new Error("LICENSE_PRIVATE_KEY_FILE is required");
  const privateKey = createPrivateKey(readFileSync(path));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Expected Ed25519 signing key");
  const publicKey = createPublicKey(privateKey);
  const kid = hash(publicKey.export({ type: "spki", format: "der" }) as Buffer).slice(0, 16);
  return { privateKey, publicKey, kid };
}
export function signLease(claims: LeaseClaims, signer: { privateKey: KeyObject; kid: string }) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: signer.kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign(null, Buffer.from(input, "ascii"), signer.privateKey).toString("base64url")}`;
}

// Reference verifier for the integration tool. The iOS client must pin this public key.
export function verifyLease(token: string, trustedPublicKey: KeyObject, expectedDevice: string, now = Math.floor(Date.now() / 1000)): LeaseClaims {
  if (token.length > 4096) throw new Error("Invalid lease");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((s) => !s || !/^[A-Za-z0-9_-]+$/.test(s))) throw new Error("Invalid lease");
  const [headerText, payloadText, signatureText] = parts;
  const signature = Buffer.from(signatureText, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== signatureText) throw new Error("Invalid signature encoding");
  const header = JSON.parse(Buffer.from(headerText, "base64url").toString("utf8"));
  const kid = hash(trustedPublicKey.export({ type: "spki", format: "der" }) as Buffer).slice(0, 16);
  if (header.alg !== "EdDSA" || header.typ !== "JWT" || header.kid !== kid || header.crit !== undefined) throw new Error("Unexpected signature algorithm or key");
  if (!verify(null, Buffer.from(`${headerText}.${payloadText}`, "ascii"), trustedPublicKey, signature)) throw new Error("Invalid signature");
  const c = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8")) as LeaseClaims;
  if (c.v !== 1 || c.iss !== LICENSE_ISSUER || c.aud !== LICENSE_AUDIENCE || !/^[1-9]\d{0,19}$/.test(c.sub)
    || (c.nonce !== undefined && (typeof c.nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(c.nonce)))
    || c.device !== expectedDevice || !/^[a-f0-9]{64}$/.test(c.device)
    || !Number.isSafeInteger(c.version) || c.version < 1
    || ![c.iat, c.exp, c.licenseExpiresAt].every(Number.isSafeInteger)
    || c.iat > now + 120 || c.exp <= now || c.exp <= c.iat || c.exp - c.iat > LEASE_SECONDS || c.exp > c.licenseExpiresAt) throw new Error("Invalid or expired lease claims");
  if (c.identity !== undefined) parseIdentityConfig(c.identity);
  return c;
}
