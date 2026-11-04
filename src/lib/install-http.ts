import { NextResponse } from "next/server";
import { InputError, record } from "./validation";
export const privateHeaders = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
export function installJson(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { ...privateHeaders, ...(status === 429 ? { "Retry-After": "60" } : {}) } });
}
export function installFailure(error: unknown) {
  if (error instanceof InputError) return installJson({ error: error.message }, error.status);
  console.error("Installation operation failed.");
  return installJson({ error: "Chưa thể xử lý bản cài. Hãy thử lại sau." }, 503);
}
export async function limitedBody(request: Request, limit: number) {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new InputError("Dữ liệu quá lớn.", 413);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new InputError("Dữ liệu quá lớn.", 413); }
      chunks.push(value);
    }
  } finally { reader?.releaseLock(); }
  return Buffer.concat(chunks);
}
export async function installJsonBody(request: Request, limit = 4096) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new InputError("Cần gửi JSON.", 415);
  const bytes = await limitedBody(request, limit);
  try { return record(JSON.parse(bytes.toString("utf8"))); }
  catch { throw new InputError("Dữ liệu không hợp lệ."); }
}
export function xml(value: string) { return value.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!); }
