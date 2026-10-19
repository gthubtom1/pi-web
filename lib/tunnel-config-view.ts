/**
 * The fixed domain's shapes and validators, in a module a client component may
 * import: no filesystem, no secrets. `lib/tunnel-config.ts` stores the config and
 * re-exports these, so the panel and the server agree on what a valid token and
 * hostname look like.
 */

export type TunnelMode = "quick" | "named";

/** What the panel may see: the token is reduced to a boolean. */
export interface TunnelConfigView {
  mode: TunnelMode;
  hostname: string;
  autoStart: boolean;
  hasToken: boolean;
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
  // An address literal is already trusted by request security; a tunnel hostname
  // must be a name Cloudflare actually serves, not "127.0.0.1" typed into a box.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return null;
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
