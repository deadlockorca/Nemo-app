import { cookies } from "next/headers";
import { appOrigin, sameOrigin } from "@/lib/http";
import { getDb } from "@/lib/db";
import { tokenHash } from "@/lib/password";
import { INSTALL_COOKIE, installationStatus, issueDownload, loginInstallation, queueInstallation } from "@/lib/installations";
import { installFailure, installJson, installJsonBody } from "@/lib/install-http";
export const runtime = "nodejs";
type Context = { params: Promise<{ action: string }> };
export async function GET(_request: Request, context: Context) {
  try {
    if ((await context.params).action !== "status") return installJson({ error: "Không tìm thấy." }, 404);
    return installJson(await installationStatus((await cookies()).get(INSTALL_COOKIE)?.value));
  } catch (e) { return installFailure(e); }
}
export async function POST(request: Request, context: Context) {
  try {
    if (!sameOrigin(request)) return installJson({ error: "Yêu cầu không hợp lệ." }, 403);
    const { action } = await context.params;
    const body = await installJsonBody(request);
    const token = (await cookies()).get(INSTALL_COOKIE)?.value;
    if (action === "login") {
      const result = await loginInstallation(body.code);
      const response = installJson({ ok: true });
      response.cookies.set(INSTALL_COOKIE, result.token, { httpOnly: true, secure: new URL(appOrigin()).protocol === "https:", sameSite: "strict", path: "/", maxAge: result.expiresIn });
      return response;
    }
    if (action === "logout") {
      if (token && /^[a-f0-9]{64}$/.test(token)) await getDb().execute(`DELETE FROM ios_install_sessions WHERE token_hash = ?`, [tokenHash(token)]);
      const response = installJson({ ok: true });
      response.cookies.set(INSTALL_COOKIE, "", { httpOnly: true, secure: new URL(appOrigin()).protocol === "https:", sameSite: "strict", path: "/", maxAge: 0 });
      return response;
    }
    if (action === "prepare") return installJson(await queueInstallation(token), 202);
    if (action === "link") {
      const result = await issueDownload(token);
      const manifest = new URL(`/api/install/download/${result.token}/manifest.plist`, appOrigin()).href;
      return installJson({ installUrl: `itms-services://?action=download-manifest&url=${encodeURIComponent(manifest)}`, expiresAt: result.expiresAt, expiresIn: result.expiresIn, https: manifest.startsWith("https:") });
    }
    return installJson({ error: "Không tìm thấy." }, 404);
  } catch (e) { return installFailure(e); }
}
