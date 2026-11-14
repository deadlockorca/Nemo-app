import { NextResponse } from "next/server";
import { appOrigin } from "@/lib/http";
import { resolveLocation, LocationApiError } from "@/lib/location-api";
import { InputError } from "@/lib/validation";

export const runtime = "nodejs";
const json = (value: unknown, status = 200) => NextResponse.json(value, {
  status, headers: { "Cache-Control": "no-store", ...(status === 429 ? { "Retry-After": "60" } : {}) },
});
export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== appOrigin()) return json({ code: "INVALID_ORIGIN" }, 403);
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return json({ code: "INVALID_CONTENT_TYPE" }, 415);
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); return json({ code: "PAYLOAD_TOO_LARGE" }, 413); }
      chunks.push(value);
    }
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    return json(await resolveLocation(request, raw));
  } catch (error) {
    if (error instanceof LocationApiError) return json({ code: error.code }, error.status);
    if (error instanceof InputError || error instanceof TypeError) return json({ code: "INVALID_REQUEST" }, error instanceof InputError ? error.status : 400);
    console.error("Location context API unavailable; request content omitted.");
    return json({ code: "SERVICE_UNAVAILABLE" }, 503);
  }
}
