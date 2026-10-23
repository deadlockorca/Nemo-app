import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { destroySession, SESSION_COOKIE } from "@/lib/auth";
import { formRedirect, sameOrigin } from "@/lib/http";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return new NextResponse("Forbidden", { status: 403 });
  try {
    await destroySession((await cookies()).get(SESSION_COOKIE)?.value);
    const response = formRedirect("/");
    response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
    return response;
  } catch {
    return new NextResponse("Chưa thể đăng xuất. Vui lòng thử lại.", { status: 503 });
  }
}
