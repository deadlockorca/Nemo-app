import { spawn } from "node:child_process";
import path from "node:path";
import { prepareStorage, storageRoot, SigningError } from "./install-storage";
import type { ProfileInspection } from "./device-profile-types";

export async function inspectProvisioningProfile(data: Buffer): Promise<ProfileInspection> {
  await prepareStorage();
  return new Promise((resolve, reject) => {
    const child = spawn(/* turbopackIgnore: true */ process.env.IOS_SIGN_PYTHON || "python3", [path.join(process.cwd(), "scripts/ios/package.py")], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "", stopped = false;
    const timer = setTimeout(() => { stopped = true; child.kill("SIGTERM"); }, 30000);
    child.stdout.on("data", chunk => { output += chunk.toString(); if (output.length > 128 * 1024) { stopped = true; child.kill("SIGTERM"); } });
    child.stdin.on("error", () => {});
    child.on("error", () => { clearTimeout(timer); reject(new SigningError("signer_python_unavailable")); });
    child.on("close", code => {
      clearTimeout(timer);
      try {
        if (stopped) throw new SigningError("worker_interrupted");
        const result = JSON.parse(output);
        if (code !== 0 || result.error) throw new SigningError(/^[a-z_]{1,60}$/.test(result.error) ? result.error : "invalid_profile_signature");
        if (!Array.isArray(result.udids) || !result.udids.length || result.udids.length > 1000 || result.udids.some((d: unknown) => typeof d !== "string" || !/^(?:[0-9A-F]{8}-[0-9A-F]{16}|[0-9A-F]{40})$/.test(d))) throw new SigningError("invalid_profile_signature");
        resolve(result);
      } catch (e) { reject(e instanceof SigningError ? e : new SigningError("invalid_profile_signature")); }
    });
    child.stdin.end(JSON.stringify({ mode: "inspect-profile", profile: data.toString("base64"), tempRoot: storageRoot() }));
  });
}
