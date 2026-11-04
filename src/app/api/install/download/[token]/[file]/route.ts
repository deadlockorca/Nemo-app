import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { appOrigin } from "@/lib/http";
import { authorizedDownload } from "@/lib/installations";
import { objectPath } from "@/lib/install-storage";
import { installFailure, installJson, privateHeaders, xml } from "@/lib/install-http";
export const runtime = "nodejs";
type Context = { params: Promise<{ token: string; file: string }> };
async function handle(request: Request, context: Context) {
  try {
    const { token, file } = await context.params;
    if (file !== "manifest.plist" && file !== "Nemo.ipa") return installJson({ error: "Không tìm thấy." }, 404);
    const row = await authorizedDownload(token);
    if (file === "manifest.plist") {
      const url = new URL(`/api/install/download/${token}/Nemo.ipa`, appOrigin()).href;
      const manifest = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>items</key><array><dict><key>assets</key><array><dict><key>kind</key><string>software-package</string><key>url</key><string>${xml(url)}</string></dict></array><key>metadata</key><dict><key>bundle-identifier</key><string>${xml(row.metadata.bundle)}</string><key>bundle-version</key><string>${xml(row.metadata.build)}</string><key>kind</key><string>software</string><key>title</key><string>Nemo</string></dict></dict></array></dict></plist>\n`;
      return new Response(request.method === "HEAD" ? null : manifest, { headers: { ...privateHeaders, "Content-Type": "application/xml; charset=utf-8", "Content-Length": String(Buffer.byteLength(manifest)) } });
    }
    const path = objectPath(row.output_key, "ipa");
    const { size } = await stat(path);
    let start = 0, end = size - 1, partial = false;
    const range = request.headers.get("range");
    const headers: Record<string, string> = { ...privateHeaders, "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="Nemo.ipa"', "Accept-Ranges": "bytes", ETag: `"${row.output_sha256}"` };
    if (range && (!request.headers.get("if-range") || request.headers.get("if-range") === headers.ETag)) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
      if (!match[1]) start = Math.max(0, size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), size - 1); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size || (match[2] === "0" && !match[1])) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
      partial = true;
      headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    }
    headers["Content-Length"] = String(end - start + 1);
    if (request.method === "HEAD") return new Response(null, { status: partial ? 206 : 200, headers });
    const fileStream = createReadStream(path, { start, end });
    const abort = () => { fileStream.destroy(); };
    request.signal.addEventListener("abort", abort, { once: true });
    fileStream.once("close", () => request.signal.removeEventListener("abort", abort));
    return new Response(Readable.toWeb(fileStream) as ReadableStream<Uint8Array>, { status: partial ? 206 : 200, headers });
  } catch (e) { return installFailure(e); }
}
export const GET = handle;
export const HEAD = handle;
