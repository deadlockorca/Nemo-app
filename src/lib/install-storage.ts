import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, unlink, chmod } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { PackageMetadata } from "./installation-types";

export function storageRoot() {
  const configured = process.env.INSTALL_STORAGE_DIR;
  if (!configured || !path.isAbsolute(configured)) throw new Error("INSTALL_STORAGE_DIR must be absolute");
  const root = path.resolve(configured);
  const relative = path.relative(path.join(process.cwd(), "public"), root);
  if (!relative || !relative.startsWith("..")) throw new Error("Install storage must be outside public");
  return root;
}
function encryptionKey() {
  const key = process.env.INSTALL_STORAGE_KEY || "";
  if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new Error("INSTALL_STORAGE_KEY must be a 32-byte hex secret");
  return Buffer.from(key, "hex");
}
export function objectPath(key: string, kind: "ipa" | "secret") {
  if (!/^[a-f0-9]{32}$/.test(key)) throw new Error("Invalid storage reference");
  // Runtime private storage is never a deployment asset.
  return path.join(/* turbopackIgnore: true */ storageRoot(), `${key}.${kind}`);
}
export async function prepareStorage() {
  encryptionKey();
  await mkdir(storageRoot(), { recursive: true, mode: 0o700 });
  await chmod(storageRoot(), 0o700);
}
export async function storeObject(data: Buffer, kind: "ipa" | "secret") {
  await prepareStorage();
  const key = randomBytes(16).toString("hex");
  let payload = data;
  if (kind === "secret") {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
    cipher.setAAD(Buffer.from(`nemo-install-v1:${key}`));
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    payload = Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
  }
  await writeFile(objectPath(key, kind), payload, { mode: 0o600, flag: "wx" });
  return key;
}
export async function loadSecret(key: string): Promise<SigningSecrets> {
  const data = await readFile(objectPath(key, "secret"));
  if (data[0] !== 1 || data.length < 30) throw new Error("Invalid encrypted signing assets");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), data.subarray(1, 13));
  decipher.setAAD(Buffer.from(`nemo-install-v1:${key}`));
  decipher.setAuthTag(data.subarray(13, 29));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(29)), decipher.final()]).toString("utf8"));
}
export async function removeObject(key: string, kind: "ipa" | "secret") {
  await unlink(objectPath(key, kind)).catch((e) => { if (e.code !== "ENOENT") throw e; });
}
export type SigningSecrets = { p12: string; profile: string; password: string };
export class SigningError extends Error { constructor(public code: string) { super("Signing operation failed"); } }
export async function runPackager(input: SigningSecrets & {
  mode: "inspect" | "sign"; source: string; udid: string; output?: string; expectedSourceSha256?: string;
}): Promise<PackageMetadata & { outputSha256?: string; verified?: boolean }> {
  await prepareStorage();
  if (input.mode === "sign" && !["darwin", "linux"].includes(process.platform)) throw new SigningError("unsupported_signer");
  return new Promise((resolve, reject) => {
    // Python is supplied by the host. Trace the fixed helper via next.config,
    // never the runtime executable path or the surrounding project directory.
    const child = spawn(/* turbopackIgnore: true */ process.env.IOS_SIGN_PYTHON || "python3", [path.join(process.cwd(), "scripts/ios/package.py")], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "", overflow = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 10 * 60 * 1000);
    child.stdout.on("data", (chunk) => { output += chunk.toString(); if (output.length > 32768) { overflow = true; child.kill("SIGTERM"); } });
    child.stdin.on("error", () => { /* close/error below determines the outcome */ });
    child.on("error", () => { clearTimeout(timer); reject(new SigningError("signer_python_unavailable")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        if (overflow || timedOut) throw new SigningError("worker_interrupted");
        const result = JSON.parse(output);
        if (code !== 0 || result.error) throw new SigningError(/^[a-z_]{1,60}$/.test(result.error) ? result.error : "invalid_signing_assets");
        if (!result.blankIdentity || result.name !== "Nemo" || result.bundle !== "vn.fractal.nemo-rebuild") throw new SigningError("wrong_app");
        resolve(result);
      } catch (e) { reject(e instanceof SigningError ? e : new SigningError("invalid_signing_assets")); }
    });
    child.stdin.end(JSON.stringify({ ...input, tempRoot: storageRoot() }));
  });
}
