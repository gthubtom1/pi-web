import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentDir } from "./agent-dir";

/**
 * The password pi-web checks when a browser logs in.
 *
 * Precedence:
 *   1. `PI_WEB_PASSWORD` set to a non-empty string -> use it (operator's choice).
 *   2. `PI_WEB_PASSWORD` set to "" -> authentication disabled (trusted machine).
 *   3. Otherwise -> a strong random secret generated once and stored in
 *      `<agentDir>/pi-web-secret` (mode 0600). Never committed, never in source,
 *      stable across restarts so a phone stays paired.
 *
 * There is deliberately NO password in the source code: the old hard-coded
 * default leaked to anyone reading the repository.
 */

export const WEB_SECRET_FILE_NAME = "pi-web-secret";
const SECRET_BYTES = 24; // 24 random bytes -> 32 base64url chars

function defaultAgentDir(): string {
  return resolveAgentDir();
}

function secretPath(agentDir: string): string {
  return join(agentDir, WEB_SECRET_FILE_NAME);
}

function readSecretFile(agentDir: string): string | null {
  const path = secretPath(agentDir);
  if (!existsSync(path)) return null;
  try {
    const value = readFileSync(path, "utf-8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** A fresh strong secret, URL-safe so it never needs escaping in a link. */
export function generateSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

function writeSecretFile(agentDir: string, value: string): void {
  try {
    if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
  } catch {
    // ignore; writeFileSync will report
  }
  const path = secretPath(agentDir);
  writeFileSync(path, `${value}\n`, { encoding: "utf-8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows best-effort
  }
}

/**
 * The secret stored in the file, generating and persisting one on first use.
 * Returns "" when the agent dir is not writable (auth then simply cannot be
 * enabled by file; callers treat "" as "disabled").
 */
function ensureFileSecret(agentDir: string): string {
  const existing = readSecretFile(agentDir);
  if (existing) return existing;
  const generated = generateSecret();
  try {
    writeSecretFile(agentDir, generated);
    return generated;
  } catch {
    return "";
  }
}

export interface ResolveSecretOptions {
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
}

/**
 * Settings › Remote access can switch authentication off without an env var
 * (Windows cannot even set an empty one). Stored next to the secret so a single
 * directory holds this install's auth decisions; a missing, corrupt or unexpected
 * file keeps authentication ON, which is the safe default.
 */
export const WEB_AUTH_FILE_NAME = "pi-web-auth.json";

export interface WebAuthSettings {
  /** false = anyone who can reach the port may use the agent. */
  requirePassword: boolean;
}

function authSettingsPath(agentDir: string): string {
  return join(agentDir, WEB_AUTH_FILE_NAME);
}

/** Read the UI's auth switch (defaults to required). */
export function readWebAuthSettings(agentDir: string = defaultAgentDir()): WebAuthSettings {
  const path = authSettingsPath(agentDir);
  if (!existsSync(path)) return { requirePassword: true };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { requirePassword?: unknown };
    return { requirePassword: parsed?.requirePassword !== false };
  } catch {
    return { requirePassword: true };
  }
}

/** Persist the UI's auth switch. */
export function writeWebAuthSettings(settings: WebAuthSettings, agentDir: string = defaultAgentDir()): WebAuthSettings {
  try {
    if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
  } catch {
    // writeFileSync reports a real failure
  }
  const next = { requirePassword: settings.requirePassword !== false };
  writeFileSync(authSettingsPath(agentDir), `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  return next;
}

/** The effective password: see the precedence at the top of this file. */
export function resolveWebPassword(options: ResolveSecretOptions = {}): string {
  const env = options.env ?? process.env;
  if (env.PI_WEB_PASSWORD !== undefined) return env.PI_WEB_PASSWORD;
  const agentDir = options.agentDir ?? defaultAgentDir();
  // The browser switch only matters while no env var pins the answer.
  if (!readWebAuthSettings(agentDir).requirePassword) return "";
  return ensureFileSecret(agentDir);
}

/** Where the auth decision comes from, for Settings › Remote access. */
export function describeWebAuth(options: ResolveSecretOptions = {}): {
  required: boolean;
  source: "env" | "env-disabled" | "generated" | "disabled";
  secretPath: string;
} {
  const env = options.env ?? process.env;
  const agentDir = options.agentDir ?? defaultAgentDir();
  if (env.PI_WEB_PASSWORD !== undefined) {
    const off = env.PI_WEB_PASSWORD === "";
    return { required: !off, source: off ? "env-disabled" : "env", secretPath: secretPath(agentDir) };
  }
  return readWebAuthSettings(agentDir).requirePassword
    ? { required: true, source: "generated", secretPath: secretPath(agentDir) }
    : { required: false, source: "disabled", secretPath: secretPath(agentDir) };
}

/** Where the generated secret lives (for display / rotation UI). */
export function webSecretPath(options: ResolveSecretOptions = {}): string {
  return secretPath(options.agentDir ?? defaultAgentDir());
}

/** Whether the effective password comes from the env var rather than the file. */
export function isPasswordFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_WEB_PASSWORD !== undefined;
}

/** The password stored in the file (may exist while remote auth is switched off). */
export function readStoredSecret(options: ResolveSecretOptions = {}): string | null {
  return readSecretFile(options.agentDir ?? defaultAgentDir());
}

/**
 * Replace the stored remote password with `value` and require it again. This is
 * what Settings › Remote access writes when someone types their own password or
 * asks for a new random one; it never touches `PI_WEB_PASSWORD`, which still wins.
 */
export function setStoredSecret(value: string, options: ResolveSecretOptions = {}): string {
  const agentDir = options.agentDir ?? defaultAgentDir();
  const trimmed = value.trim();
  if (trimmed.length < 6) throw new Error("A remote password needs at least 6 characters.");
  writeSecretFile(agentDir, trimmed);
  writeWebAuthSettings({ requirePassword: true }, agentDir);
  return trimmed;
}

/** Generate a fresh random remote password, store it and require it again. */
export function randomizeStoredSecret(options: ResolveSecretOptions = {}): string {
  return setStoredSecret(generateSecret(), options);
}

/**
 * Rotate the stored secret: generate a new one, persist it, return it. Callers
 * must be authenticated. Does nothing to the env var (an env password wins, so
 * rotation only matters when the file is the source).
 */
export function rotateStoredSecret(options: ResolveSecretOptions = {}): string {
  const agentDir = options.agentDir ?? defaultAgentDir();
  const next = generateSecret();
  writeSecretFile(agentDir, next);
  return next;
}
