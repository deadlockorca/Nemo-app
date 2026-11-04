import { readdir, unlink } from "node:fs/promises";
import path from "node:path";

// Next copies loaded .env files into standalone independently of route traces.
// Deployment receives runtime secrets separately, never from the build machine.
const root = path.join(process.cwd(), process.env.NEMO_NEXT_DIST_DIR || ".next", "standalone");
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.startsWith(".env")) await unlink(path.join(root, entry.name));
}
await import("./check-install-build.mjs");
