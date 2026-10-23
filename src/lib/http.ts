import "server-only";
import { NextResponse } from "next/server";

export function appOrigin() {
  const url = new URL(process.env.APP_URL || "http://localhost:3000");
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("APP_URL must use HTTPS in production");
  }
  return url.origin;
}

export function sameOrigin(request: Request) {
  return request.headers.get("origin") === appOrigin();
}

export function formRedirect(path: string) {
  const response = NextResponse.redirect(new URL(path, appOrigin()), 303);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
