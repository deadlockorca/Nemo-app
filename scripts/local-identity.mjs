import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
const env = JSON.parse(readFileSync(new URL("../.local/blank-identity/env.json", import.meta.url), "utf8"));
if (env.DB_HOST !== "127.0.0.1" || env.DB_NAME !== "nemo_blank_test" || !env.LICENSE_PRIVATE_KEY_FILE.includes("/.local/blank-identity/")) throw new Error("Dedicated local environment required");
const args = process.argv.slice(2);
if (!args.length) throw new Error("Supply a command");
const child = spawn(args[0], args.slice(1), { stdio: "inherit", env: { ...process.env, ...env } });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
child.on("error", () => { process.exitCode = 1; });
