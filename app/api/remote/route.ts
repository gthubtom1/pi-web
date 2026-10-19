import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { issuePairToken } from "@/lib/pairing";
import { getWebPassword, isWebPasswordEnabled } from "@/lib/web-auth";
import { describeWebAuth, writeWebAuthSettings } from "@/lib/web-secret";
import { listRemoteAddresses } from "@/lib/remote-access";
import { getTunnelState, startTunnel, stopTunnel, uninstallTunnel } from "@/lib/tunnel";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function serverPort(request: Request): number {
  const host = request.headers.get("host") ?? "";
  const fromHost = Number(host.split(":").pop());
  if (Number.isInteger(fromHost) && fromHost > 0) return fromHost;
  const url = new URL(request.url);
  return Number(url.port) || (url.protocol === "https:" ? 443 : 80);
}

/**
 * GET /api/remote
 * Everything the Settings › Remote Access panel needs: the machine's LAN and
 * Tailscale addresses, the tunnel state, and whether a real (non-default)
 * password is set — a public tunnel refuses to start without one.
 */
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const addresses = listRemoteAddresses();
  const tunnel = getTunnelState();
  const auth = describeWebAuth();
  return NextResponse.json(
    {
      port: serverPort(request),
      lan: addresses.lan,
      tailscale: addresses.tailscale,
      tunnel,
      passwordEnabled: isWebPasswordEnabled(getWebPassword()),
      // Settings › Remote access renders the switch from these.
      authRequired: auth.required,
      authSource: auth.source,
      secretPath: auth.secretPath,
    },
    { headers: NO_STORE },
  );
}

/**
 * POST /api/remote  body { action: "pair" | "tunnel-start" | "tunnel-stop" | "tunnel-uninstall" | "set-password-required" }
 */
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  const body = await request.json().catch(() => null) as { action?: unknown; required?: unknown } | null;
  const action = typeof body?.action === "string" ? body.action : "";
  const password = getWebPassword();

  switch (action) {
    case "set-password-required": {
      // A switch the user flips while signed in; the env var still wins over it.
      if (typeof body?.required !== "boolean") {
        return NextResponse.json({ error: "required must be a boolean" }, { status: 400, headers: NO_STORE });
      }
      if (process.env.PI_WEB_PASSWORD !== undefined) {
        return NextResponse.json(
          { error: "PI_WEB_PASSWORD decides authentication; unset it to use this switch." },
          { status: 409, headers: NO_STORE },
        );
      }
      const saved = writeWebAuthSettings({ requirePassword: body.required });
      const auth = describeWebAuth();
      return NextResponse.json(
        { authRequired: saved.requirePassword, authSource: auth.source, passwordEnabled: saved.requirePassword },
        { headers: NO_STORE },
      );
    }
    case "pair": {
      if (!isWebPasswordEnabled(password)) {
        return NextResponse.json({ error: "Authentication is disabled" }, { status: 409, headers: NO_STORE });
      }
      const { token, expiresAt } = issuePairToken(password);
      return NextResponse.json({ token, expiresAt }, { headers: NO_STORE });
    }
    case "tunnel-start": {
      // A public tunnel exposes a high-privilege agent: refuse without a password.
      if (!isWebPasswordEnabled(password)) {
        return NextResponse.json(
          { error: "Set a password before opening a public tunnel (PI_WEB_PASSWORD, or enable the generated secret)." },
          { status: 409, headers: NO_STORE },
        );
      }
      const state = startTunnel(serverPort(request));
      return NextResponse.json({ tunnel: state }, { headers: NO_STORE });
    }
    case "tunnel-stop": {
      return NextResponse.json({ tunnel: stopTunnel() }, { headers: NO_STORE });
    }
    case "tunnel-uninstall": {
      return NextResponse.json({ tunnel: await uninstallTunnel() }, { headers: NO_STORE });
    }
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400, headers: NO_STORE });
  }
}
