import { NextResponse } from "next/server";
import { challenge, prove, LicenseApiError } from "@/lib/license-api";

const json = (value: unknown, status = 200) => NextResponse.json(value, {
  status, headers: { "Cache-Control": "no-store", ...(status === 429 ? { "Retry-After": "60" } : {}) },
});
async function readBody(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new LicenseApiError("invalid_request", "Cần gửi JSON.", 415);
  const reader = request.body?.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 4096) { await reader.cancel(); throw new LicenseApiError("invalid_request", "Dữ liệu quá lớn.", 413); }
    parts.push(value);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new LicenseApiError("invalid_request", "JSON không hợp lệ."); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new LicenseApiError("invalid_request", "Dữ liệu không hợp lệ.");
  return data as Record<string, unknown>;
}
export async function POST(request: Request, context: { params: Promise<{ operation: string }> }) {
  try {
    const { operation } = await context.params;
    if (!["challenge", "activate", "verify"].includes(operation)) return json({ code: "not_found", error: "Không tìm thấy API." }, 404);
    // Native apps do not send Origin. Browser cross-origin calls are not supported.
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(process.env.APP_URL || "http://localhost:3000").origin) return json({ code: "invalid_origin", error: "Yêu cầu không hợp lệ." }, 403);
    const data = await readBody(request);
    return json(operation === "challenge" ? await challenge(data) : await prove(operation as "activate" | "verify", data));
  } catch (error) {
    if (error instanceof LicenseApiError) return json({ code: error.code, error: error.message }, error.status);
    console.error("License API unavailable; request content omitted.");
    return json({ code: "unavailable", error: "Máy chủ tạm thời chưa sẵn sàng. Vui lòng thử lại sau." }, 503);
  }
}
