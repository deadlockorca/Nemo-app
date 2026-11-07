import "./env";
import { setTimeout as delay } from "node:timers/promises";
import { getDb } from "../src/lib/db";
import { deliverCertificateAlert, monitorEnabled, monitorHeartbeat, queueExpiryAlerts, runCertificateCheck } from "../src/lib/certificate-monitor";

let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
if (!monitorEnabled()) {
  console.log("Certificate monitor disabled. Set CERTIFICATE_MONITOR_ENABLED=true to run it.");
} else {
  console.log("Certificate monitor started: hourly checks. Signing assets, email credentials and customer identifiers are not logged.");
  let expiryAt = 0, heartbeatAt = 0;
  const heartbeat = setInterval(() => { void monitorHeartbeat().catch(() => { /* main loop reports database failures */ }); }, 30000);
  try {
    do {
      try {
        if (Date.now() >= heartbeatAt) { await monitorHeartbeat(); heartbeatAt = Date.now() + 60000; }
        if (Date.now() >= expiryAt) { await queueExpiryAlerts(); expiryAt = Date.now() + 3600000; }
        const checked = await runCertificateCheck();
        for (let n = 0; n < 5 && !stopping; n++) if (!await deliverCertificateAlert()) break;
        if (process.argv.includes("--once")) break;
        if (!stopping) await delay(checked ? 1000 : 30000);
      } catch {
        console.error("Certificate monitor cycle failed. Check database, Python and storage configuration.");
        await monitorHeartbeat("cycle_failed").catch(() => {});
        if (process.argv.includes("--once")) { process.exitCode = 1; break; }
        if (!stopping) await delay(30000);
      }
    } while (!stopping);
  } finally { clearInterval(heartbeat); await getDb().end(); }
}
