import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getDynamicHosts } from "@/lib/dynamic-hosts";
import { matchPairing, readRemotePairing, scopeForHost } from "@/lib/remote-pairing";
import {
  createWebSessionToken,
  getWebAuthKey,
  PI_WEB_SESSION_COOKIE,
  PI_WEB_SESSION_MAX_AGE,
} from "@/lib/web-auth";

export const dynamic = "force-dynamic";

function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:"
    || request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim() === "https";
}

/**
 * POST /api/web-auth/pair  body { code } | { secret }.
 *
 * Redeems a pairing credential for a session cookie. The QR link carries the
 * high-entropy `secret` in the URL fragment; typing the short code sends `code`.
 * Both are the same credential, so one device pairs either way, and the entry it
 * arrived on (LAN vs public tunnel) decides which code was asked for.
 */
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  const body = await request.json().catch(() => null) as { code?: unknown; secret?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code : undefined;
  const secret = typeof body?.secret === "string" ? body.secret : undefined;
  if (!code && !secret) {
    return NextResponse.json({ error: "code is required" }, { status: 400 });
  }

  const scope = scopeForHost(request.headers.get("host"), getDynamicHosts());
  const matched = matchPairing(readRemotePairing(), scope, { code, secret });
  if (matched === false) {
    return NextResponse.json({ error: "Wrong pairing code" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true, pairingDisabled: matched === undefined });
  response.cookies.set({
    name: PI_WEB_SESSION_COOKIE,
    value: createWebSessionToken(getWebAuthKey()),
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: PI_WEB_SESSION_MAX_AGE,
  });
  return response;
}
