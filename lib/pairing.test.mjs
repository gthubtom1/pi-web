import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const pairing = await jiti.import("./pairing.ts");

const SECRET = "test-secret";

test("a fresh token verifies once, then is single-use", () => {
  const { token } = pairing.issuePairToken(SECRET);
  assert.equal(pairing.consumePairToken(SECRET, token), true);
  assert.equal(pairing.consumePairToken(SECRET, token), false, "second use rejected");
});

test("expired tokens are rejected", () => {
  const now = Date.now();
  const { token, expiresAt } = pairing.issuePairToken(SECRET, now);
  assert.equal(pairing.consumePairToken(SECRET, token, expiresAt + 1), false);
});

test("forged or malformed tokens are rejected", () => {
  assert.equal(pairing.consumePairToken(SECRET, ""), false);
  assert.equal(pairing.consumePairToken(SECRET, "garbage"), false);
  assert.equal(pairing.consumePairToken(SECRET, "123.bad"), false);
  const { token } = pairing.issuePairToken(SECRET);
  assert.equal(pairing.consumePairToken("other-secret", token), false, "wrong secret");
  // Tamper with the signature. Flip to a different character: appending "0" would
  // occasionally produce the original token (a flaky 1-in-64 failure).
  const last = token.slice(-1);
  assert.equal(pairing.consumePairToken(SECRET, `${token.slice(0, -1)}${last === "A" ? "B" : "A"}`), false);
});

test("the token carries no password, only an expiry and signature", () => {
  const { token } = pairing.issuePairToken(SECRET);
  assert.match(token, /^\d+\.[A-Za-z0-9_-]+$/);
  assert.equal(token.includes(SECRET), false);
});
