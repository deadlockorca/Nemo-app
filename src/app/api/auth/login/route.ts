import { NextResponse } from "next/server";
import { authenticate, destroySession, SESSION_COOKIE, SESSION_SECONDS } from "@/lib/auth";
import { formRedirect, sameOrigin } from "@/lib/http";
import { normalizeUsername, validUsername } from "@/lib/password";
import { cookies } from "next/headers";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return new NextResponse("Forbidden", { status: 403 });
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    return new NextResponse("Unsupported content type", { status: 415 });
  }
  // Read a bounded stream instead of trusting Content-Length.
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) { await reader.cancel(); return new NextResponse("Too large", { status: 413 }); }
      chunks.push(value);
    }
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const username = normalizeUsername(form.get("username") || "");
  const password = form.get("password") || "";
  if (!validUsername(username) || !password || Buffer.byteLength(password) > 256) return formRedirect("/?error=invalid");
  try {
    const result = await authenticate(username, password);
    if (result.kind !== "ok") return formRedirect(`/?error=${result.kind}`);
    // Rotate any existing browser session at login.
    await destroySession((await cookies()).get(SESSION_COOKIE)?.value);
    const response = formRedirect("/admin");
    response.cookies.set(SESSION_COOKIE, result.token, {
      httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: SESSION_SECONDS,
    });
    return response;
  } catch {
    console.error("Admin login failed: database operation unavailable.");
    return formRedirect("/?error=unavailable");
  }
}
