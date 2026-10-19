import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const p = await jiti.import("./remote-pairing.ts");

function tempDir() {
  return mkdtempSync(join(tmpdir(), "remote-pairing-"));
}

test("codes are 8 chars from the confusion-reduced alphabet, and random per scope", () => {
  const dir = tempDir();
  try {
    const state = p.readRemotePairing(dir);
    assert.match(state.lan.code, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.match(state.public.code, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.notEqual(state.lan.code, state.public.code);
    assert.ok(state.lan.secret.length >= 30);
    assert.equal(state.lan.enabled, true);
    assert.equal(state.public.enabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a custom code is 6-12 letters/digits, case-insensitive, and persists", () => {
  const dir = tempDir();
  try {
    assert.equal(p.normalizeCustomCode("888888"), "888888");
    assert.equal(p.normalizeCustomCode("mycode2026"), "MYCODE2026");
    assert.equal(p.normalizeCustomCode("abc"), null, "too short");
    assert.equal(p.normalizeCustomCode("abcdefghijklm"), null, "too long");
    assert.equal(p.normalizeCustomCode("abc-123"), null, "not letters/digits");

    p.updateRemotePairing((state) => { state.lan.code = "MYCODE2026"; }, dir);
    assert.equal(p.readRemotePairing(dir).lan.code, "MYCODE2026");
    // The file is plaintext on purpose: the panel re-reads the code after a restart.
    assert.match(readFileSync(join(dir, p.REMOTE_PAIRING_FILE_NAME), "utf-8"), /MYCODE2026/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a scope matches its own code and secret only, case-insensitively", () => {
  const dir = tempDir();
  try {
    const state = p.readRemotePairing(dir);
    assert.equal(p.matchPairing(state, "lan", { code: state.lan.code.toLowerCase() }), true);
    assert.equal(p.matchPairing(state, "lan", { code: state.public.code }), false, "the public code does not open the LAN");
    assert.equal(p.matchPairing(state, "public", { secret: state.public.secret }), true);
    assert.equal(p.matchPairing(state, "public", { secret: state.lan.secret }), false);
    assert.equal(p.matchPairing(state, "lan", { code: "ZZZZZZZZ" }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a disabled scope needs no pairing at all", () => {
  const dir = tempDir();
  try {
    const state = p.readRemotePairing(dir);
    state.lan.enabled = false;
    assert.equal(p.matchPairing(state, "lan", { code: "anything" }), undefined);
    // The other entry is unaffected: the switches are separate.
    assert.equal(p.matchPairing(state, "public", { code: "anything" }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the tunnel's hostname selects the public code, anything else the LAN code", () => {
  const hosts = ["abc-123.trycloudflare.com"];
  assert.equal(p.scopeForHost("abc-123.trycloudflare.com", hosts), "public");
  assert.equal(p.scopeForHost("ABC-123.trycloudflare.com:443", hosts), "public");
  assert.equal(p.scopeForHost("192.168.0.100:30141", hosts), "lan");
  assert.equal(p.scopeForHost("100.101.102.103:30141", hosts), "lan");
  assert.equal(p.scopeForHost(null, hosts), "lan");
});

test("a corrupt file falls back to fresh credentials instead of throwing", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, p.REMOTE_PAIRING_FILE_NAME), "{ not json", "utf-8");
    const state = p.readRemotePairing(dir);
    assert.match(state.lan.code, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.equal(state.lan.enabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
