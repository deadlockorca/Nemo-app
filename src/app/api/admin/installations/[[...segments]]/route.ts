import { currentAdmin } from "@/lib/auth";
import { sameOrigin } from "@/lib/http";
import { adminInstallations, createInstallation, updateInstallation } from "@/lib/installations";
import { installFailure, installJson, installJsonBody, limitedBody } from "@/lib/install-http";
import { InputError } from "@/lib/validation";

export const runtime = "nodejs";
type Context = { params: Promise<{ segments?: string[] }> };
export async function GET(_request: Request, context: Context) {
  try {
    if (!await currentAdmin()) return installJson({ error: "Hãy đăng nhập quản trị." }, 401);
    if ((await context.params).segments?.length) return installJson({ error: "Không tìm thấy." }, 404);
    return installJson(await adminInstallations());
  } catch (e) { return installFailure(e); }
}
export async function POST(request: Request, context: Context) {
  try {
    const admin = await currentAdmin();
    if (!admin) return installJson({ error: "Hãy đăng nhập quản trị." }, 401);
    if (!sameOrigin(request)) return installJson({ error: "Yêu cầu không hợp lệ." }, 403);
    const parts = (await context.params).segments || [];
    if (parts.length === 2) {
      await installJsonBody(request);
      return installJson(await updateInstallation(admin, parts[0], parts[1]));
    }
    if (parts.length) return installJson({ error: "Không tìm thấy." }, 404);
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.startsWith("multipart/form-data;")) throw new InputError("Cần chọn các tệp tải lên.", 415);
    const bytes = await limitedBody(request, 154 * 1024 * 1024);
    let form: FormData;
    try { form = await new Response(bytes, { headers: { "Content-Type": contentType } }).formData(); }
    catch { throw new InputError("Không đọc được dữ liệu tải lên."); }
    return installJson(await createInstallation(admin, form), 201);
  } catch (e) { return installFailure(e); }
}
