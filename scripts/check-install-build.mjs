import assert from "node:assert/strict";
import { readdir, access } from "node:fs/promises";
import path from "node:path";

const root = path.join(process.cwd(), process.env.NEMO_NEXT_DIST_DIR || ".next", "standalone");
async function check(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    const relative = path.relative(root, file);
    assert.ok(entry.name !== ".local" && !entry.name.startsWith(".env") && !/\.(p12|pfx|mobileprovision)$/.test(entry.name) && entry.name !== "private.pem", `Private file in deployment output: ${relative}`);
    if (entry.isDirectory()) await check(file);
  }
}
await check(root);
for (const name of ["package.py", "macho.py", "verify.py", "apple-chain.pem", "signing_assets.py", "certificate_status.py"]) await access(path.join(root, "scripts/ios", name));
console.log("PASS: standalone contains the fixed signing helpers; no .local, .env, signing certificates/profiles or private.pem files.");
