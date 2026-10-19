import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * One-time pairing tokens for "scan a QR code and log in".
 *
 * A token is a short-lived, HMAC-signed payload: `<expiresAtMs>.<sig>`. It is
 * stateless (any server process can verify it from the same secret), expires
 * after {@link PAIR_TTL_MS}, and is single-use on a best-effort basis (a process
 * remembers the ones it has consumed). The QR therefore never carries the real
 * password — only a token that stops working almost immediately.
 */

export const PAIR_TTL_MS = 2 * 60 * 1000;

declare global {
  var __piWebUsedPairTokens: Map<string, number> | undefined;
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(`pi-web-pair:${payload}`).digest("base64url");
}

export interface IssuedPairToken {
  token: string;
  expiresAt: number;
}

export function issuePairToken(secret: string, now = Date.now()): IssuedPairToken {
  const expiresAt = now + PAIR_TTL_MS;
  const payload = String(expiresAt);
  return { token: `${payload}.${sign(secret, payload)}`, expiresAt };
}

/** Verify and consume a pairing token. Returns false for expired/forged/reused. */
export function consumePairToken(secret: string, token: string, now = Date.now()): boolean {
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expiresAt = Number(payload);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;

  const expected = sign(secret, payload);
  const actual = Buffer.from(signature, "utf8");
  const want = Buffer.from(expected, "utf8");
  if (actual.length !== want.length || !timingSafeEqual(actual, want)) return false;

  const used = (globalThis.__piWebUsedPairTokens ??= new Map<string, number>());
  for (const [key, exp] of used) {
    if (exp <= now) used.delete(key);
  }
  if (used.has(token)) return false;
  used.set(token, expiresAt);
  return true;
}
