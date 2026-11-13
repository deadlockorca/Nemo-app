import "./env";
import { setTimeout as delay } from "node:timers/promises";
import { getDb } from "../src/lib/db";
import { cleanupInstallTokens, runSigningJob } from "../src/lib/installations";
import { runReplacementJob } from "../src/lib/signing-replacements";
import { prepareStorage } from "../src/lib/install-storage";

let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
try {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("The signing worker requires macOS or Linux.");
  await prepareStorage();
  console.log("Nemo signing worker started. Signing assets and passwords are not logged.");
  let cleanupAt = 0, replacementTurn = false;
  do {
    if (Date.now() > cleanupAt) { await cleanupInstallTokens(); cleanupAt = Date.now() + 60000; }
    const worked = replacementTurn ? await runReplacementJob() || await runSigningJob() : await runSigningJob() || await runReplacementJob();
    replacementTurn = !replacementTurn;
    if (process.argv.includes("--once")) break;
    if (!worked && !stopping) await delay(2000);
  } while (!stopping);
} catch {
  console.error("Signing worker stopped. Check signing tools, storage configuration and database availability.");
  process.exitCode = 1;
} finally { await getDb().end(); }
