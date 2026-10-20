import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentDir } from "./agent-dir";

/**
 * The public tunnel's one persistent setting: whether `pi-web` starts it by itself.
 *
 * The tunnel is a Cloudflare quick tunnel (a random `trycloudflare.com` address,
 * no account, no token), so this file holds no credential at all. It used to also
 * hold a named tunnel's token and hostname; that mode was removed, and a file left
 * by it is read for `autoStart` alone and rewritten without the rest.
 */

export const TUNNEL_CONFIG_FILE_NAME = "pi-web-tunnel.json";

export interface TunnelConfig {
  version: 1;
  /** Start the tunnel when pi-web starts. Off by default. */
  autoStart: boolean;
}

export const EMPTY_TUNNEL_CONFIG: TunnelConfig = { version: 1, autoStart: false };

export function tunnelConfigPath(agentDir: string = resolveAgentDir()): string {
  return join(agentDir, TUNNEL_CONFIG_FILE_NAME);
}

export function readTunnelConfig(agentDir: string = resolveAgentDir()): TunnelConfig {
  const path = tunnelConfigPath(agentDir);
  if (!existsSync(path)) return { ...EMPTY_TUNNEL_CONFIG };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { autoStart?: unknown };
    return { version: 1, autoStart: parsed.autoStart === true };
  } catch {
    // A corrupt file must not stop the server from starting.
    return { ...EMPTY_TUNNEL_CONFIG };
  }
}

/** Atomic write. A failure throws; the caller reports it. */
export function writeTunnelConfig(config: TunnelConfig, agentDir: string = resolveAgentDir()): void {
  mkdirSync(agentDir, { recursive: true });
  const path = tunnelConfigPath(agentDir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, autoStart: config.autoStart === true }, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows has no POSIX mode; the file is inside the user's own agent dir.
  }
  renameSync(tmp, path);
}

export function updateTunnelConfig(
  mutate: (config: TunnelConfig) => void,
  agentDir: string = resolveAgentDir(),
): TunnelConfig {
  const config = readTunnelConfig(agentDir);
  mutate(config);
  writeTunnelConfig(config, agentDir);
  return readTunnelConfig(agentDir);
}

/** What the panel may see. */
export function tunnelConfigView(config: TunnelConfig): { autoStart: boolean } {
  return { autoStart: config.autoStart };
}
