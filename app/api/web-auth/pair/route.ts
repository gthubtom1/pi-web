import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { consumePairToken } from "@/lib/pairing";
import {
  createWebSessionToken,
  getWebPassword,
  isWebPasswordEnabled,
  PI_WEB_SESSION_COOKIE,
  PI_WEB_SESSION_MAX_AGE,
} from "@/lib/web-auth";

export const dynamic = "force-dynamic";

function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:"
    || request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim() === "https";
}

/**
 * POST /api/web-auth/pair  body { token }.
 * Redeems a one-time pairing token (from a scanned QR code) for a session
 * cookie, so the phone logs in without ever seeing the real password. The
 * token is short-lived and single-use (lib/pairing.ts).
 */
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  const password = getWebPassword();
  if (!isWebPasswordEnabled(password)) {
    // Auth is off: nothing to pair, just succeed so the client proceeds to "/".
    return NextResponse.json({ ok: true });
  }

  const body = await request.json().catch(() => null) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token : "";
  if (!token || !consumePairToken(password, token)) {
    return NextResponse.json({ error: "Invalid or expired pairing code" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: PI_WEB_SESSION_COOKIE,
    value: createWebSessionToken(password),
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: PI_WEB_SESSION_MAX_AGE,
  });
  return response;
}
