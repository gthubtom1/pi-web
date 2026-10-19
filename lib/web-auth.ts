import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentDir } from "./agent-dir";
import { resolveWebPassword } from "./web-secret";

export const PI_WEB_AUTH_USERNAME = "pi";
export const PI_WEB_SESSION_COOKIE = "pi_web_session";
export const PI_WEB_SESSION_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * The effective password: `PI_WEB_PASSWORD` when set (empty string = auth off),
 * otherwise a strong random secret generated once and stored in the agent dir
 * (lib/web-secret.ts). No password lives in the source code.
 */
export function getWebPassword(): string {
  return resolveWebPassword();
}

/** Signature key for session cookies when no password is configured. */
export const WEB_SESSION_KEY_FILE_NAME = "pi-web-session-key";

/**
 * The key that signs session cookies. A configured password signs them; with no
 * password (remote pairing only) a random key generated once in the agent dir does,
 * so a paired device keeps its cookie across restarts.
 */
export function getWebAuthKey(agentDir: string = resolveAgentDir()): string {
  const password = getWebPassword();
  if (isWebPasswordEnabled(password)) return password;
  const path = join(agentDir, WEB_SESSION_KEY_FILE_NAME);
  try {
    if (existsSync(path)) {
      const value = readFileSync(path, "utf-8").trim();
      if (value) return value;
    }
    const generated = randomBytes(32).toString("base64url");
    try {
      if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
    } catch {
      // writeFileSync reports a real failure
    }
    writeFileSync(path, `${generated}
`, { encoding: "utf-8", mode: 0o600 });
    return generated;
  } catch {
    // Unwritable agent dir: the cookie lasts only for this process.
    return (globalThis as { __piWebVolatileAuthKey?: string }).__piWebVolatileAuthKey
      ??= randomBytes(32).toString("base64url");
  }
}

function hashSecret(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function secretsEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(hashSecret(actual), hashSecret(expected));
}

export function isWebPasswordEnabled(
  password: string | undefined = getWebPassword(),
): password is string {
  return typeof password === "string" && password.length > 0;
}

/**
 * Whether the operator pinned a remote password (`PI_WEB_PASSWORD`).
 *
 * Remote access is gated by pairing codes (per entry) and by this password only
 * when an operator sets one; the generated secret in the agent dir is just the
 * cookie-signing key and must NOT be read as "a password is required".
 */
export function isOperatorPasswordEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.PI_WEB_PASSWORD === "string" && env.PI_WEB_PASSWORD.length > 0;
}

/** The operator password itself, or "" when none is pinned. */
export function getOperatorPassword(env: NodeJS.ProcessEnv = process.env): string {
  return isOperatorPasswordEnabled(env) ? String(env.PI_WEB_PASSWORD) : "";
}

export function isValidWebPassword(
  suppliedPassword: string,
  password = getWebPassword(),
): boolean {
  return isWebPasswordEnabled(password) && secretsEqual(suppliedPassword, password);
}

export function isValidBasicAuthorization(
  authorization: string | null,
  password = getWebPassword(),
): boolean {
  if (!isWebPasswordEnabled(password) || !authorization) return false;

  const match = /^Basic\s+(\S+)$/i.exec(authorization);
  if (!match) return false;

  let credentials: string;
  try {
    const decoded = Buffer.from(match[1], "base64");
    if (decoded.toString("base64") !== match[1]) return false;
    credentials = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    return false;
  }

  const separator = credentials.indexOf(":");
  if (separator === -1) return false;

  const username = credentials.slice(0, separator);
  const suppliedPassword = credentials.slice(separator + 1);
  const usernameMatches = secretsEqual(username, PI_WEB_AUTH_USERNAME);
  const passwordMatches = isValidWebPassword(suppliedPassword, password);
  return usernameMatches && passwordMatches;
}

function sessionSignature(payload: string, password: string): string {
  return createHmac("sha256", password).update(`pi-web-session:${payload}`, "utf8").digest("hex");
}

export function createWebSessionToken(
  password: string,
  now = Date.now(),
  nonce = randomBytes(16).toString("hex"),
): string {
  const payload = `v1.${Math.floor(now / 1000) + PI_WEB_SESSION_MAX_AGE}.${nonce}`;
  return `${payload}.${sessionSignature(payload, password)}`;
}

export function isValidWebSessionToken(
  token: string | undefined,
  password = getWebPassword(),
  now = Date.now(),
): boolean {
  if (!token || !isWebPasswordEnabled(password)) return false;

  const match = /^(v1\.(\d+)\.[a-f0-9]{32})\.([a-f0-9]{64})$/.exec(token);
  if (!match) return false;

  const expiresAt = Number(match[2]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1000)) return false;
  return secretsEqual(match[3], sessionSignature(match[1], password));
}
