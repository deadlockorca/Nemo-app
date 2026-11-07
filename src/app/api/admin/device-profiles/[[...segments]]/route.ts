import { attachMonitorProfile } from "@/lib/certificate-assets";
import { currentAdmin } from "@/lib/auth";
import { sameOrigin } from "@/lib/http";
import { deleteDeviceProfile, listDeviceProfiles, saveDeviceProfile } from "@/lib/device-profiles";
import { installJson, installJsonBody, limitedBody } from "@/lib/install-http";
import { InputError } from "@/lib/validation";
import { inspectProvisioningProfile } from "@/lib/profile-inspection";
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
    if (request.method === "GET" && !parts.length) return installJson(await listDeviceProfiles(new URL(request.url).searchParams));
    if (request.method === "POST" && parts.length === 2 && ["certificate", "certificate-inspect"].includes(parts[1])) {
      const type = request.headers.get("content-type") || "";
      if (!type.startsWith("multipart/form-data;")) throw new InputError("Chọn tệp .mobileprovision.", 415);
      const bytes = await limitedBody(request, 2 * 1024 * 1024 + 16384);
      let form: FormData;
      try { form = await new Response(bytes, { headers: { "Content-Type": type } }).formData(); }
      catch { throw new InputError("Không đọc được dữ liệu tải lên."); }
      return installJson(await attachMonitorProfile(admin, parts[0], form, parts[1] === "certificate-inspect"));
    }
    if (request.method === "POST" && parts.length === 1 && parts[0] === "inspect") {
      const type = request.headers.get("content-type") || "";
      if (!type.startsWith("multipart/form-data;")) throw new InputError("Chọn tệp .mobileprovision.", 415);
      const bytes = await limitedBody(request, 2 * 1024 * 1024 + 16384);
      let form: FormData;
      try { form = await new Response(bytes, { headers: { "Content-Type": type } }).formData(); }
      catch { throw new InputError("Không đọc được dữ liệu tải lên."); }
      const file = form.get("profile");
      if (!(file instanceof File) || !file.size || file.size > 2 * 1024 * 1024) throw new InputError("Profile cần có dung lượng tối đa 2 MB.");
      return installJson(await inspectProvisioningProfile(Buffer.from(await file.arrayBuffer())));
    }
    if (request.method === "POST" && !parts.length) return installJson(await saveDeviceProfile(admin, await installJsonBody(request, 16384)), 201);
    if (request.method === "PATCH" && parts.length === 1) return installJson(await saveDeviceProfile(admin, await installJsonBody(request, 16384), parts[0]));
    if (request.method === "DELETE" && parts.length === 1) return installJson(await deleteDeviceProfile(admin, parts[0], await installJsonBody(request)));
    return installJson({ error: "Không tìm thấy chức năng." }, 404);
  } catch (e) {
    if (e instanceof SigningError) return installJson({ error: signingError(e.code) }, 400);
    if (e instanceof InputError) return installJson({ error: e.message }, e.status);
    console.error("Device profile operation failed.");
    return installJson({ error: "Chưa lưu được hồ sơ. Hãy tải lại danh sách và thử lại." }, 503);
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
