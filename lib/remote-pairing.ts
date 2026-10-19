import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentDir } from "./agent-dir";
import { isTailscaleAddress } from "./remote-access";

/**
 * Remote pairing, per entry point (LAN, the public tunnel, and the Tailscale
 * tailnet — three doors, three codes: a phone on the sofa must not need the code
 * that faces the internet, and a device on the tailnet should not need the code
 * of the house's Wi-Fi either).
 *
 * A scope's credential is a PAIR: a short manual `code` (8 characters from a
 * confusion-reduced alphabet by default, or 6-12 letters/digits if the user types
 * one) and a high-entropy `secret` for the QR / copied link. Both redeem the same
 * credential, so there is one authentication system, not two. This mirrors
 * dsh-remote (AercherC) — a short code is enough because the URL is already long,
 * and the QR carries the secret in the URL *fragment* so it never reaches a server
 * log.
 *
 * Scopes are separate on purpose: each code can be turned on or off on its own, so
 * a phone on the sofa never needs the code that faces the internet, and revoking
 * one entry point never touches the others.
 *
 * The stored file holds both plaintext values: the panel has to show the code and
 * rebuild the QR after a restart (ToDesk-style). It lives in the agent directory,
 * like the session files.
 */

export const REMOTE_PAIRING_FILE_NAME = "pi-web-remote-pairing.json";
export const PAIRING_CODE_LENGTH = 8;
/** No I/L/O/0/1: a code is read off a screen and typed with a thumb. */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CUSTOM_CODE_MIN = 6;
export const CUSTOM_CODE_MAX = 12;

export type RemoteScope = "lan" | "public" | "tailscale";

export interface ScopeCredential {
  /** false = this entry needs no pairing at all (open). */
  enabled: boolean;
  code: string;
  secret: string;
}

export interface RemotePairingState {
  version: 1;
  lan: ScopeCredential;
  public: ScopeCredential;
  /** The tailnet (100.64.0.0/10): its own code, independent of the LAN one. */
  tailscale: ScopeCredential;
}

function root(agentDir: string): string {
  return join(agentDir, REMOTE_PAIRING_FILE_NAME);
}

/** Uniform over the alphabet (rejection sampling; 256 mod 31 is not 0). */
export function generateCode(length = PAIRING_CODE_LENGTH): string {
  const alphabetLength = PAIRING_CODE_ALPHABET.length;
  const rejectAbove = Math.floor(256 / alphabetLength) * alphabetLength;
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= rejectAbove) continue;
      out += PAIRING_CODE_ALPHABET[byte % alphabetLength];
      if (out.length === length) break;
    }
  }
  return out;
}

export function generateSecret(): string {
  return randomBytes(24).toString("base64url");
}

/** A custom code is 6-12 letters/digits, case-insensitive (stored upper-case). */
export function normalizeCustomCode(input: string): string | null {
  const value = input.trim().toUpperCase();
  if (value.length < CUSTOM_CODE_MIN || value.length > CUSTOM_CODE_MAX) return null;
  return /^[A-Z0-9]+$/.test(value) ? value : null;
}

function emptyCredential(): ScopeCredential {
  return { enabled: true, code: generateCode(), secret: generateSecret() };
}

function normalizeCredential(input: unknown): ScopeCredential {
  const record = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const code = typeof record.code === "string" && normalizeCustomCode(record.code) ? record.code.toUpperCase() : generateCode();
  const secret = typeof record.secret === "string" && record.secret.length >= 16 ? record.secret : generateSecret();
  return { enabled: record.enabled !== false, code, secret };
}

export function readRemotePairing(agentDir: string = resolveAgentDir()): RemotePairingState {
  const path = root(agentDir);
  if (!existsSync(path)) {
    // Persist on first read: a code that changed on every page load would break
    // both the QR (its secret) and a phone that was typing it.
    const initial: RemotePairingState = {
      version: 1,
      lan: emptyCredential(),
      public: emptyCredential(),
      tailscale: emptyCredential(),
    };
    try {
      writeRemotePairing(initial, agentDir);
    } catch {
      // read-only agent dir: the codes stay valid for this process only
    }
    return initial;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const state: RemotePairingState = {
      version: 1,
      lan: normalizeCredential(parsed.lan),
      public: normalizeCredential(parsed.public),
      tailscale: normalizeCredential(parsed.tailscale),
    };
    // A file written before the tailnet got its own scope: persist the generated
    // credential once, or every read would hand out a different code.
    if (parsed.tailscale === undefined) {
      try {
        writeRemotePairing(state, agentDir);
      } catch {
        // read-only agent dir: the code stays valid for this process only
      }
    }
    return state;
  } catch {
    return {
      version: 1,
      lan: emptyCredential(),
      public: emptyCredential(),
      tailscale: emptyCredential(),
    };
  }
}

/** Atomic write; the caller has already validated the change. */
export function writeRemotePairing(state: RemotePairingState, agentDir: string = resolveAgentDir()): void {
  try {
    if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
  } catch {
    // writeFileSync reports a real failure
  }
  const path = root(agentDir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
}

/** Read the state, let `mutate` change it, write it back (single writer: the server). */
export function updateRemotePairing(
  mutate: (state: RemotePairingState) => void,
  agentDir: string = resolveAgentDir(),
): RemotePairingState {
  const state = readRemotePairing(agentDir);
  mutate(state);
  writeRemotePairing(state, agentDir);
  return state;
}

/**
 * The credential a request belongs to, from the Host it arrived with: the tunnel's
 * own hostname is the public door, a 100.64/10 address is the tailnet, and anything
 * else (the LAN, a loopback name) is the LAN door.
 */
export function scopeForHost(host: string | null, tunnelHostnames: readonly string[]): RemoteScope {
  if (!host) return "lan";
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (tunnelHostnames.some((candidate) => candidate.toLowerCase() === hostname)) return "public";
  // The tailnet has its own code: a device there must not need (or learn) the LAN one.
  if (isTailscaleAddress(hostname)) return "tailscale";
  return "lan";
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a.toUpperCase(), "utf8");
  const right = Buffer.from(b.toUpperCase(), "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Whether `submitted` (a typed code or a QR secret) opens this scope.
 * `undefined` when the scope needs no pairing (credential disabled).
 */
export function matchPairing(
  state: RemotePairingState,
  scope: RemoteScope,
  submitted: { code?: string; secret?: string },
): boolean | undefined {
  const credential = state[scope];
  if (!credential.enabled) return undefined;
  if (submitted.secret && safeEqual(submitted.secret, credential.secret)) return true;
  const code = submitted.code?.trim();
  if (code && safeEqual(code, credential.code)) return true;
  return false;
}
