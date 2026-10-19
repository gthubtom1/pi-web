import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentDir } from "./agent-dir";

/**
 * The tunnel's persistent settings: which mode (a random quick tunnel or a fixed
 * named one), the named tunnel's token, the public hostname that tunnel serves,
 * and whether `pi-web` starts it by itself.
 *
 * Nothing here is hard-coded: the hostname and the token are the operator's, typed
 * into Settings › Remote access and kept in the agent dir with mode 0600, next to
 * the session files. The token is a credential — it is never put in a log line,
 * never in an error message, and never sent back to the browser (the panel only
 * learns `hasToken`).
 */

export const TUNNEL_CONFIG_FILE_NAME = "pi-web-tunnel.json";

export type TunnelMode = "quick" | "named";

export interface TunnelConfig {
  version: 1;
  mode: TunnelMode;
  /** Named-tunnel credential. Empty in quick mode. */
  token: string;
  /** Exact public hostname the named tunnel serves (no wildcard, no scheme). */
  hostname: string;
  /** Start the tunnel when pi-web starts. Off by default. */
  autoStart: boolean;
}

/** What the panel may see: the credential is reduced to a boolean. */
export interface TunnelConfigView {
  mode: TunnelMode;
  hostname: string;
  autoStart: boolean;
  hasToken: boolean;
}

export const EMPTY_TUNNEL_CONFIG: TunnelConfig = {
  version: 1,
  mode: "quick",
  token: "",
  hostname: "",
  autoStart: false,
};

export function tunnelConfigPath(agentDir: string = resolveAgentDir()): string {
  return join(agentDir, TUNNEL_CONFIG_FILE_NAME);
}

/**
 * A hostname the request-security allow-list can hold: one exact DNS name, lower
 * case, no wildcard. A scheme, a port or a path is refused rather than quietly
 * stripped — the panel says what is wrong instead of publishing something else.
 */
export function normalizeTunnelHostname(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase().replace(/\.$/, "");
  if (!value || value.length > 253) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)) return null;
  // A single label ("localhost", a bare IP) is never a public entry point.
  if (value.split(".").some((label) => label.length > 63)) return null;
  if (value === "localhost" || value.endsWith(".localhost")) return null;
  // No wildcard: only this one name is trusted, never a whole zone.
  if (value.includes("*")) return null;
  return value;
}

/** Whether a string looks like a Cloudflare tunnel token rather than a paste accident. */
export function normalizeTunnelToken(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (value.length < 20 || value.length > 4096) return null;
  // Tokens are base64url (sometimes JSON, sometimes dotted): no whitespace, no
  // shell metacharacters. Nothing is interpolated into a command line — the token
  // travels in the child's environment (lib/tunnel.ts) — but keeping it a single
  // opaque blob also keeps it out of a copy-paste accident.
  return /^[A-Za-z0-9+/=_.:-]+$/.test(value) ? value : null;
}

function normalizeConfig(input: unknown): TunnelConfig {
  const record = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const token = normalizeTunnelToken(record.token) ?? "";
  const hostname = normalizeTunnelHostname(record.hostname) ?? "";
  const mode: TunnelMode = record.mode === "named" && token && hostname ? "named" : "quick";
  return { version: 1, mode, token, hostname, autoStart: record.autoStart === true };
}

export function readTunnelConfig(agentDir: string = resolveAgentDir()): TunnelConfig {
  const path = tunnelConfigPath(agentDir);
  if (!existsSync(path)) return { ...EMPTY_TUNNEL_CONFIG };
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    // A corrupt file is not a reason to refuse to start: fall back to quick mode.
    return { ...EMPTY_TUNNEL_CONFIG };
  }
}

/** Atomic write, owner-only. A failure throws (the caller reports it) — never logs the token. */
export function writeTunnelConfig(config: TunnelConfig, agentDir: string = resolveAgentDir()): void {
  const normalized = normalizeConfig(config);
  mkdirSync(agentDir, { recursive: true });
  const path = tunnelConfigPath(agentDir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
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
  // Keep mode and credential consistent whichever way the caller edited them.
  const normalized = normalizeConfig(config);
  writeTunnelConfig(normalized, agentDir);
  return normalized;
}

/** The client-safe view: no token. */
export function tunnelConfigView(config: TunnelConfig): TunnelConfigView {
  return {
    mode: config.mode,
    hostname: config.hostname,
    autoStart: config.autoStart,
    hasToken: config.token.length > 0,
  };
}
