import { generateKeyPairSync, createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const directory = resolve(process.argv[2] || ".local/license-keys");
const privatePath = resolve(directory, "private.pem");
const publicPath = resolve(directory, "public.pem");
if (existsSync(privatePath) || existsSync(publicPath)) throw new Error("Key files already exist; refusing to overwrite.");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const keys = generateKeyPairSync("ed25519");
writeFileSync(privatePath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
writeFileSync(publicPath, keys.publicKey.export({ type: "spki", format: "pem" }), { flag: "wx", mode: 0o644 });
const kid = createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
console.log(`Created signing key ${kid}.\nPrivate key: ${privatePath}\nPublic key: ${publicPath}\nSet LICENSE_PRIVATE_KEY_FILE to the private-key path. Never distribute private.pem.`);
