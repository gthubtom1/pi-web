import { NextResponse, type NextRequest } from "next/server";
import {
  getAuthRetryAfterMs,
  recordAuthFailure,
  recordAuthSuccess,
  retryAfterSeconds,
} from "@/lib/auth-throttle";
import {
  hasJsonContentType,
  isApiRequestAllowed,
  isLoopbackHostHeader,
} from "@/lib/request-security";
import { getDynamicHosts } from "@/lib/dynamic-hosts";
import { matchPairing, readRemotePairing, scopeForHost } from "@/lib/remote-pairing";
import {
  createWebSessionToken,
  getOperatorPassword,
  getWebAuthKey,
  isOperatorPasswordEnabled,
  isValidBasicAuthorization,
  isValidWebSessionToken,
  PI_WEB_SESSION_COOKIE,
  PI_WEB_SESSION_MAX_AGE,
} from "@/lib/web-auth";

const NO_STORE = { "Cache-Control": "no-store" };

function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:"
    || request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim() === "https";
}

function clearSessionCookie(response: NextResponse): NextResponse {
  response.cookies.set({
    name: PI_WEB_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}

function setSessionCookie(response: NextResponse, request: Request): NextResponse {
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

/**
 * GET /api/web-auth — what the login page and the client need to know.
 * `enabled` is this entry point's answer: the local browser never signs in, a LAN
 * or tunnel visitor signs in while that entry's pairing code is on (or while
 * PI_WEB_PASSWORD pins a password).
 */
export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const host = request.headers.get("host");
  const localBrowser = isLoopbackHostHeader(host);
  const password = getOperatorPassword();
  const passwordEnabled = isOperatorPasswordEnabled();
  const scope = scopeForHost(host, getDynamicHosts());
  const pairingEnabled = readRemotePairing()[scope].enabled;
  const enabled = !localBrowser && (passwordEnabled || pairingEnabled);
  const authenticated = !enabled
    || localBrowser
    || isValidWebSessionToken(request.cookies.get(PI_WEB_SESSION_COOKIE)?.value, getWebAuthKey())
    || (passwordEnabled && isValidBasicAuthorization(request.headers.get("authorization"), password));

  return NextResponse.json(
    { enabled, authenticated, scope, passwordEnabled, pairingEnabled },
    { headers: NO_STORE },
  );
}

/**
 * POST /api/web-auth — sign in with this entry's pairing code, or with the password
 * when an operator pinned one (`PI_WEB_PASSWORD`). Sets the session cookie.
 */
export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  const body = await request.json().catch(() => null) as { code?: unknown; password?: unknown; secret?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code : undefined;
  const password = typeof body?.password === "string" ? body.password : undefined;
  const secret = typeof body?.secret === "string" ? body.secret : undefined;

  const configured = getOperatorPassword();
  const passwordEnabled = isOperatorPasswordEnabled();
  if (!passwordEnabled && !code && !secret) {
    return NextResponse.json({ error: "A pairing code is required" }, { status: 400, headers: NO_STORE });
  }

  // Pairing codes are short, so every attempt shares one throttle: behind a tunnel
  // every request comes from cloudflared on 127.0.0.1, and a per-source lock would
  // let one stranger lock the owner out.
  const retryAfterMs = getAuthRetryAfterMs();
  if (retryAfterMs > 0) {
    return NextResponse.json(
      { error: "Too many failed attempts" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(retryAfterSeconds(retryAfterMs)) } },
    );
  }

  const scope = scopeForHost(request.headers.get("host"), getDynamicHosts());
  const matched = matchPairing(readRemotePairing(), scope, { code, secret });
  // Basic/API compatibility: with PI_WEB_PASSWORD set, that password also signs in.
  const passwordOk = passwordEnabled && password !== undefined && isValidBasicAuthorization(
    `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`,
    configured,
  );
  if (matched === true || passwordOk) {
    recordAuthSuccess();
    return setSessionCookie(NextResponse.json({ ok: true }, { headers: NO_STORE }), request);
  }
  if (matched === undefined) {
    // This entry needs no pairing at all: let the caller through.
    recordAuthSuccess();
    return setSessionCookie(NextResponse.json({ ok: true, pairingDisabled: true }, { headers: NO_STORE }), request);
  }
  recordAuthFailure();
  return NextResponse.json({ error: "Wrong or expired pairing code" }, { status: 401, headers: NO_STORE });
}

/** DELETE /api/web-auth — sign out (clears this browser's session cookie). */
export async function DELETE(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  return clearSessionCookie(NextResponse.json({ ok: true }, { headers: NO_STORE }));
}
