import { NextResponse } from "next/server";
import { currentAdmin } from "@/lib/auth";
import { sameOrigin } from "@/lib/http";
import { createLicense, changeLicense, InputError, listRecords, record, releaseDevice, saveCustomer, type Section } from "@/lib/management";

const sections: Section[] = ["customers", "licenses", "devices", "activity"];
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
type Context = { params: Promise<{ segments: string[] }> };

async function body(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new InputError("Cần gửi dữ liệu JSON.", 415);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 16384) { await reader.cancel(); throw new InputError("Dữ liệu quá lớn.", 413); }
    chunks.push(value);
  }
  try { return record(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch (error) { if (error instanceof InputError) throw error; throw new InputError("JSON không hợp lệ."); }
}
async function handle(request: Request, context: Context) {
  try {
    const admin = await currentAdmin();
    if (!admin) return json({ error: "Phiên đăng nhập đã hết. Hãy đăng nhập lại." }, 401);
    if (request.method !== "GET" && !sameOrigin(request)) return json({ error: "Yêu cầu không hợp lệ." }, 403);
    const parts = (await context.params).segments;
    const [section, id, operation] = parts;
    if (request.method === "GET" && parts.length === 1 && sections.includes(section as Section)) {
      return json(await listRecords(section as Section, new URL(request.url).searchParams));
    }
    if (request.method === "POST" && parts.length === 1 && section === "customers") return json(await saveCustomer(admin, await body(request)), 201);
    if (request.method === "PATCH" && parts.length === 2 && section === "customers") return json(await saveCustomer(admin, await body(request), id));
    if (request.method === "POST" && parts.length === 1 && section === "licenses") return json(await createLicense(admin, await body(request)), 201);
    if (request.method === "POST" && parts.length === 3 && section === "licenses") return json(await changeLicense(admin, id, operation, await body(request)));
    if (request.method === "POST" && parts.length === 3 && section === "devices" && operation === "release") return json(await releaseDevice(admin, id, await body(request)));
    return json({ error: "Không tìm thấy chức năng." }, 404);
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.message }, error.status);
    console.error("Admin management operation failed.");
    return json({ error: "Chưa thể xử lý. Hãy tải lại danh sách để kiểm tra kết quả trước khi thử lại." }, 503);
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
