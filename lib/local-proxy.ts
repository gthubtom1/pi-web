import { connect } from "node:net";

/**
 * Find the local proxy a "梯子" (Clash / v2ray / Mihomo / Surge …) exposes, so
 * the cloudflared download and its connection work on a China machine without
 * the user configuring anything. Never hard-coded to one port: it reads the
 * standard proxy environment variables first, then probes the ports those
 * clients commonly listen on locally, and only returns something that actually
 * accepts a TCP connection right now. Returns null when no proxy is present
 * (direct connection is then correct).
 */

export const COMMON_LOCAL_PROXY_PORTS = [7890, 7897, 1080, 10809, 10808, 8889, 2080, 8080, 20171];

/** The proxy URL from the environment, if any (http(s) or socks). */
export function proxyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw =
    env.HTTPS_PROXY || env.https_proxy ||
    env.HTTP_PROXY || env.http_proxy ||
    env.ALL_PROXY || env.all_proxy ||
    "";
  const value = raw.trim();
  if (!value) return null;
  // A bare "host:port" is not a URL; assume http.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
}

function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Probe the usual local proxy ports; the first that accepts a connection wins. */
export async function detectLocalProxyPort(
  ports: readonly number[] = COMMON_LOCAL_PROXY_PORTS,
  host = "127.0.0.1",
  timeoutMs = 250,
): Promise<string | null> {
  const results = await Promise.all(ports.map((port) => canConnect(host, port, timeoutMs).then((ok) => (ok ? port : null))));
  const found = results.find((port) => port !== null);
  return found !== undefined && found !== null ? `http://${host}:${found}` : null;
}

/**
 * The proxy to use for an outbound request: the environment's, else a detected
 * local client, else null (direct). `force` skips detection (tests).
 */
export async function resolveOutboundProxy(
  env: NodeJS.ProcessEnv = process.env,
  options: { detect?: boolean } = {},
): Promise<string | null> {
  const fromEnv = proxyFromEnv(env);
  if (fromEnv) return fromEnv;
  if (options.detect === false) return null;
  return detectLocalProxyPort();
}
