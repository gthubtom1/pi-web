import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isOperatorPasswordEnabled } from "@/lib/web-auth";

import { listRemoteAddresses } from "@/lib/remote-access";
import { getTunnelState, startTunnel, stopTunnel, uninstallTunnel } from "@/lib/tunnel";
import {
  normalizeTunnelHostname,
  normalizeTunnelToken,
  readTunnelConfig,
  tunnelConfigPath,
  tunnelConfigView,
  updateTunnelConfig,
} from "@/lib/tunnel-config";
import {
  generateCode,
  generateSecret,
  normalizeCustomCode,
  readRemotePairing,
  updateRemotePairing,
  type RemoteScope,
} from "@/lib/remote-pairing";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function serverPort(request: Request): number {
  const host = request.headers.get("host") ?? "";
  const fromHost = Number(host.split(":").pop());
  if (Number.isInteger(fromHost) && fromHost > 0) return fromHost;
  const url = new URL(request.url);
  return Number(url.port) || (url.protocol === "https:" ? 443 : 80);
}

function refusal(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function pairingView(agentDir?: string) {
  // The secret is included because the panel builds the QR from it; it is the same
  // plaintext credential the file holds, shown only after the panel is reached.
  const state = readRemotePairing(agentDir);
  const view = (credential: { enabled: boolean; code: string; secret: string }) => ({
    enabled: credential.enabled,
    code: credential.code,
    secret: credential.secret,
  });
  return {
    lan: view(state.lan),
    public: view(state.public),
    tailscale: view(state.tailscale),
  };
}

/** The fixed-domain settings, with the token reduced to `hasToken` (never echoed). */
function tunnelConfigState() {
  return { ...tunnelConfigView(readTunnelConfig()), path: tunnelConfigPath() };
}

/**
 * GET /api/remote — everything Settings › Remote access needs:
 * this machine's addresses, the tunnel state, the two pairing codes (LAN and
 * public, which are separate switches), and the fixed-domain settings.
 *
 * The named tunnel's token is never in this answer: only `hasToken`. It is a
 * credential the operator typed and it does not belong in a response the page
 * keeps in memory.
 */
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return refusal(403, "Untrusted API request");
  const addresses = listRemoteAddresses();
  const tunnel = getTunnelState();
  return NextResponse.json(
    {
      port: serverPort(request),
      lan: addresses.lan,
      tailscale: addresses.tailscale,
      tunnel,
      tunnelConfig: tunnelConfigState(),
      pairing: pairingView(),
      // PI_WEB_PASSWORD still works for API clients / operators who pin one.
      passwordEnabled: isOperatorPasswordEnabled(),
    },
    { headers: NO_STORE },
  );
}

/**
 * POST /api/remote
 *   { action: "pairing-code", scope: "lan"|"public", mode: "toggle", enabled } |
 *   { action: "pairing-code", scope, mode: "random" } |
 *   { action: "pairing-code", scope, mode: "set", code } |
 *   { action: "tunnel-start" | "tunnel-stop" | "tunnel-uninstall" | "tunnel-check" } |
 *   { action: "tunnel-config-save", mode, token?, hostname?, autoStart?, confirm } |
 *   { action: "tunnel-config-clear", confirm } |
 *   { action: "tunnel-autostart", enabled }
 *
 * Every fixed-domain write is explicit and confirmable: nothing here is derived
 * from an environment variable or a hard-coded name, and a save that replaces a
 * credential or the public address of a running tunnel needs `confirm: true` — the
 * panel asks first, so a stray click changes nothing.
 */
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return refusal(403, "Untrusted API request");
  if (!hasJsonContentType(request)) return refusal(415, "Content-Type must be application/json");

  const body = await request.json().catch(() => null) as {
    action?: unknown;
    scope?: unknown;
    mode?: unknown;
    enabled?: unknown;
    code?: unknown;
    token?: unknown;
    hostname?: unknown;
    autoStart?: unknown;
    confirm?: unknown;
  } | null;
  const action = typeof body?.action === "string" ? body.action : "";

  switch (action) {
    case "pairing-code": {
      // Three doors, three codes: the LAN, the public tunnel and the tailnet.
      const scope: RemoteScope | null = body?.scope === "lan"
        ? "lan"
        : body?.scope === "public"
          ? "public"
          : body?.scope === "tailscale"
            ? "tailscale"
            : null;
      if (!scope) return refusal(400, "scope must be \"lan\", \"public\" or \"tailscale\"");
      const mode = typeof body?.mode === "string" ? body.mode : "";
      if (mode === "toggle") {
        if (typeof body?.enabled !== "boolean") return refusal(400, "enabled must be a boolean");
        const enabled = body.enabled;
        updateRemotePairing((state) => { state[scope].enabled = enabled; });
      } else if (mode === "random") {
        // A fresh code AND a fresh secret: the old QR must stop working too.
        updateRemotePairing((state) => {
          state[scope].code = generateCode();
          state[scope].secret = generateSecret();
          state[scope].enabled = true;
        });
      } else if (mode === "set") {
        const code = typeof body?.code === "string" ? normalizeCustomCode(body.code) : null;
        if (!code) return refusal(400, "Use 6-12 letters or digits");
        updateRemotePairing((state) => {
          state[scope].code = code;
          state[scope].enabled = true;
        });
      } else {
        return refusal(400, "mode must be toggle, random or set");
      }
      return NextResponse.json({ pairing: pairingView() }, { headers: NO_STORE });
    }
    case "tunnel-start": {
      // The public entry needs a pairing code, or the whole internet could drive the
      // agent; turn it on rather than refusing with a dead end.
      const state = readRemotePairing();
      if (!state.public.enabled) {
        updateRemotePairing((next) => { next.public.enabled = true; });
      }
      return NextResponse.json({ tunnel: startTunnel(serverPort(request)), pairing: pairingView() }, { headers: NO_STORE });
    }
    case "tunnel-stop":
      return NextResponse.json({ tunnel: stopTunnel() }, { headers: NO_STORE });
    case "tunnel-uninstall":
      return NextResponse.json({ tunnel: await uninstallTunnel() }, { headers: NO_STORE });
    case "tunnel-config-save": {
      const current = readTunnelConfig();
      const mode = body?.mode === "named" ? "named" : body?.mode === "quick" ? "quick" : current.mode;
      // An empty token field means "keep the saved one": the panel never receives
      // the token, so it cannot send it back, and a blank box must not wipe it.
      const submittedToken = typeof body?.token === "string" && body.token.trim() ? body.token : null;
      const token = submittedToken === null ? current.token : normalizeTunnelToken(submittedToken);
      if (submittedToken !== null && !token) {
        return refusal(400, "That does not look like a tunnel token (copy it from the Cloudflare dashboard).");
      }
      const hostname = normalizeTunnelHostname(body?.hostname);
      if (mode === "named") {
        if (!token) return refusal(400, "The fixed domain needs the tunnel's token.");
        if (!hostname) return refusal(400, "Enter the public hostname the tunnel serves, for example pi.example.com.");
      }
      const replacesCredential = Boolean(current.token) && (submittedToken !== null || mode !== current.mode || hostname !== current.hostname);
      const running = getTunnelState().status !== "stopped";
      if ((replacesCredential || running) && body?.confirm !== true) {
        return NextResponse.json(
          { error: "Saving this replaces the credential or the public address; confirm first.", needsConfirm: true },
          { status: 409, headers: NO_STORE },
        );
      }
      try {
        updateTunnelConfig((config) => {
          config.mode = mode;
          config.token = mode === "named" ? (token ?? "") : "";
          config.hostname = mode === "named" ? (hostname ?? "") : "";
          if (typeof body?.autoStart === "boolean") config.autoStart = body.autoStart;
        });
      } catch (error) {
        return refusal(500, error instanceof Error ? error.message : String(error));
      }
      // A live tunnel keeps serving the old mode until it is replaced; restart it so
      // the address the panel shows is the one that works.
      if (running) {
        stopTunnel();
        startTunnel(serverPort(request));
      }
      return NextResponse.json(
        { tunnel: getTunnelState(), tunnelConfig: tunnelConfigState() },
        { headers: NO_STORE },
      );
    }
    case "tunnel-config-clear": {
      const current = readTunnelConfig();
      const running = getTunnelState().status !== "stopped";
      if ((current.token || current.hostname || running) && body?.confirm !== true) {
        return NextResponse.json(
          { error: "Clearing removes the fixed domain and stops the tunnel; confirm first.", needsConfirm: true },
          { status: 409, headers: NO_STORE },
        );
      }
      if (running) stopTunnel();
      try {
        updateTunnelConfig((config) => {
          config.mode = "quick";
          config.token = "";
          config.hostname = "";
        });
      } catch (error) {
        return refusal(500, error instanceof Error ? error.message : String(error));
      }
      return NextResponse.json(
        { tunnel: getTunnelState(), tunnelConfig: tunnelConfigState() },
        { headers: NO_STORE },
      );
    }
    case "tunnel-autostart": {
      if (typeof body?.enabled !== "boolean") return refusal(400, "enabled must be a boolean");
      const enabled = body.enabled;
      try {
        updateTunnelConfig((config) => { config.autoStart = enabled; });
      } catch (error) {
        return refusal(500, error instanceof Error ? error.message : String(error));
      }
      return NextResponse.json(
        { tunnel: getTunnelState(), tunnelConfig: tunnelConfigState() },
        { headers: NO_STORE },
      );
    }
    case "tunnel-check": {
      // Fetch the public address from this machine: it goes out to Cloudflare and
      // back through cloudflared, so a success proves the whole public path (DNS,
      // edge, tunnel, app) and a failure names the step that broke.
      const tunnel = getTunnelState();
      if (tunnel.status !== "running" || !tunnel.url) {
        return NextResponse.json({ check: { ok: false, error: "The tunnel is not running." } }, { headers: NO_STORE });
      }
      const started = Date.now();
      try {
        const response = await fetch(`${tunnel.url}/api/web-auth`, { signal: AbortSignal.timeout(15_000), cache: "no-store" });
        return NextResponse.json(
          { check: { ok: response.ok, status: response.status, ms: Date.now() - started } },
          { headers: NO_STORE },
        );
      } catch (error) {
        const message = error instanceof Error ? `${error.message}${error.cause instanceof Error ? ` (${error.cause.message})` : ""}` : String(error);
        // ENOTFOUND here means this machine cannot resolve the tunnel hostname; a
        // phone on the same resolver will fail the same way, and the fix is the
        // phone's DNS (or use the LAN code while both are on the same Wi-Fi).
        const dns = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message);
        return NextResponse.json(
          {
            check: {
              ok: false,
              ms: Date.now() - started,
              error: message,
              dnsFailure: dns,
            },
          },
          { headers: NO_STORE },
        );
      }
    }
    default:
      return refusal(400, "Unknown action");
  }
}
