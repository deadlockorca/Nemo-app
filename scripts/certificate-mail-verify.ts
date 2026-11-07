import "./env";
import { verifyCertificateEmail } from "../src/lib/certificate-email";
try {
  await verifyCertificateEmail();
  console.log("SMTP TLS connection and authentication succeeded. No email was sent.");
} catch {
  console.error("SMTP verification failed. Check host, port, sender and app password; no credentials were logged.");
  process.exitCode = 1;
}
