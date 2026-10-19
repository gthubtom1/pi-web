import { NextResponse } from "next/server";
import { getPairingRetryAfterMs, recordPairingFailure, recordPairingSuccess, retryAfterSeconds } from "@/lib/auth-throttle";
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

  // The QR's secret is 24 random bytes: unguessable, and throttling it would only
  // punish the phone that just scanned. A typed short code is a guess, and gets the
  // same exponential backoff as the password form (in its own bucket, so a stale
  // code on a phone cannot lock the operator out of the login page).
  const usingSecret = Boolean(secret) && !code;
  if (!usingSecret) {
    const retryAfterMs = getPairingRetryAfterMs();
    if (retryAfterMs > 0) {
      return NextResponse.json(
        { error: `Too many wrong pairing codes. Try again in ${retryAfterSeconds(retryAfterMs)}s.` },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds(retryAfterMs)), "Cache-Control": "no-store" } },
      );
    }
  }

  const scope = scopeForHost(request.headers.get("host"), getDynamicHosts());
  const matched = matchPairing(readRemotePairing(), scope, { code, secret });
  if (matched === false) {
    if (!usingSecret) recordPairingFailure();
    return NextResponse.json({ error: "Wrong pairing code" }, { status: 401 });
  }
  if (!usingSecret) recordPairingSuccess();

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
