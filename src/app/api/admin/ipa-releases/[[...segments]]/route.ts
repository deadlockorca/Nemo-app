import { currentAdmin } from "@/lib/auth";
import { sameOrigin } from "@/lib/http";
import { changeIpaRelease, listIpaReleases, uploadIpaRelease } from "@/lib/ipa-releases";
import { installJson, installJsonBody, limitedBody } from "@/lib/install-http";
import { InputError } from "@/lib/validation";
import { SigningError } from "@/lib/install-storage";
import { signingError } from "@/lib/installation-types";

export const runtime = "nodejs";
type Context = { params: Promise<{ segments?: string[] }> };
async function handle(request: Request, context: Context) {
  try {
    const admin = await currentAdmin();
    if (!admin) return installJson({ error: "Hãy đăng nhập quản trị." }, 401);
    if (request.method !== "GET" && !sameOrigin(request)) return installJson({ error: "Yêu cầu không hợp lệ." }, 403);
    const parts = (await context.params).segments || [];
    if (request.method === "GET" && !parts.length) return installJson(await listIpaReleases(new URL(request.url).searchParams));
    if (request.method === "POST" && parts.length === 2) return installJson(await changeIpaRelease(admin, parts[0], parts[1], await installJsonBody(request)));
    if (request.method !== "POST" || parts.length) return installJson({ error: "Không tìm thấy chức năng." }, 404);
    const type = request.headers.get("content-type") || "";
    if (!type.startsWith("multipart/form-data;")) throw new InputError("Chọn tệp IPA trắng.", 415);
    const bytes = await limitedBody(request, 150 * 1024 * 1024 + 16384);
    let form: FormData;
    try { form = await new Response(bytes, { headers: { "Content-Type": type } }).formData(); }
    catch { throw new InputError("Không đọc được dữ liệu tải lên."); }
    const result = await uploadIpaRelease(admin, form);
    return installJson(result, result.duplicate ? 200 : 201);
  } catch (e) {
    if (e instanceof SigningError) return installJson({ error: signingError(e.code) }, 400);
    if (e instanceof InputError) return installJson({ error: e.message }, e.status);
    console.error("IPA library operation failed.");
    return installJson({ error: "Chưa xử lý được thư viện IPA. Hãy tải lại danh sách và thử lại." }, 503);
  }
}
export const GET = handle;
export const POST = handle;
