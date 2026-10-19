import { configureHttpDispatcher, readHttpIdleTimeoutMs } from "@/lib/http-dispatcher";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { readTunnelConfig } from "@/lib/tunnel-config";

/**
 * The port this server listens on, for a tunnel started at boot. `pi-web` passes
 * PI_WEB_PORT when it spawns the server (bin/pi-web.js); `next dev` leaves it
 * unset, and its own scripts bind 30141.
 */
function configuredServerPort(): number | null {
  for (const candidate of [process.env.PI_WEB_PORT, process.env.PORT, "30141"]) {
    const port = Number(candidate);
    if (Number.isInteger(port) && port > 0) return port;
  }
  return null;
}

export function registerNodeInstrumentation(): void {
  // The pi CLI applies settings' `httpIdleTimeoutMs` to the same undici
  // body/header timeouts, so a Web UI session gets the timeout the user
  // configured. Without it the built-in five minutes aborts a provider stream
  // that stays quiet for longer, which a CLI session tolerates.
  configureHttpDispatcher(readHttpIdleTimeoutMs());

  // In production Next 16 answers SIGINT/SIGTERM with server.close() and waits
  // for every connection to end, without a timeout. SSE streams only end when
  // the client disconnects, so close them here or the process never exits.
  const shutdownStreams = () => closeAllAgentEventStreams();
  process.on("SIGINT", shutdownStreams);
  process.on("SIGTERM", shutdownStreams);

  // Remote access (Settings › Remote access): a tunnel the operator left on comes
  // back with the server, and its cloudflared dies with this process instead of
  // outliving it. Kept out of the module graph of every route so a Settings read
  // never spawns anything.
  void import("@/lib/tunnel").then((tunnel) => {
    tunnel.installTunnelShutdownHook();
    let config;
    try {
      config = readTunnelConfig();
    } catch {
      config = null;
    }
    const port = configuredServerPort();
    if (!config?.autoStart || port === null) return;
    tunnel.autoStartTunnel(port);
  }).catch(() => {
    // A tunnel is optional: never fail the server because it could not start.
  });

  // Next evaluates a route's code on its first request, so the first
  // /api/sessions used to pay for importing the whole pi SDK, seconds on
  // Windows (#964). Start that import now, unawaited so register() stays fast:
  // it overlaps the browser opening, and the routes reuse Node's cached module.
  // A failure is left for the routes' own import to report.
  import("@earendil-works/pi-coding-agent").catch(() => {});
}
