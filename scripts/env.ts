import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
const original = { ...process.env };
for (const path of [".env", ".env.local"]) {
  if (existsSync(path)) Object.assign(process.env, parseEnv(readFileSync(path, "utf8")));
}
Object.assign(process.env, original);
