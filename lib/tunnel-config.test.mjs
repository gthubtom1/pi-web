import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const config = await jiti.import("./tunnel-config.ts");
const view = await jiti.import("./tunnel-config-view.ts");

const TOKEN = "eyJhIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoiLCJ0IjoiMTIzNDU2Nzg5MCJ9";

function tempAgentDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-tunnel-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a missing file reads as quick mode with nothing configured", (t) => {
  const dir = tempAgentDir(t);
  assert.deepEqual(config.readTunnelConfig(dir), {
    version: 1,
    mode: "quick",
    token: "",
    hostname: "",
    autoStart: false,
  });
});

test("a saved fixed domain round-trips and lands in a 0600 file", (t) => {
  const dir = tempAgentDir(t);
  config.updateTunnelConfig((next) => {
    next.mode = "named";
    next.token = TOKEN;
    next.hostname = "pi.example.com";
    next.autoStart = true;
  }, dir);

  const stored = config.readTunnelConfig(dir);
  assert.equal(stored.mode, "named");
  assert.equal(stored.token, TOKEN);
  assert.equal(stored.hostname, "pi.example.com");
  assert.equal(stored.autoStart, true);

  const path = config.tunnelConfigPath(dir);
  const bytes = readFileSync(path, "utf8");
  assert.match(bytes, /"mode": "named"/);
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o777, 0o600, "the credential file is owner-only");
  }
});

test("the client view never carries the token", (t) => {
  const dir = tempAgentDir(t);
  config.writeTunnelConfig({ version: 1, mode: "named", token: TOKEN, hostname: "pi.example.com", autoStart: false }, dir);
  const shown = config.tunnelConfigView(config.readTunnelConfig(dir));
  assert.deepEqual(shown, { mode: "named", hostname: "pi.example.com", autoStart: false, hasToken: true });
  assert.ok(!JSON.stringify(shown).includes(TOKEN));
});

test("named mode needs both a token and a hostname; without them it reads as quick", (t) => {
  const dir = tempAgentDir(t);
  config.writeTunnelConfig({ version: 1, mode: "named", token: "", hostname: "pi.example.com", autoStart: false }, dir);
  assert.equal(config.readTunnelConfig(dir).mode, "quick");

  config.writeTunnelConfig({ version: 1, mode: "named", token: TOKEN, hostname: "", autoStart: false }, dir);
  assert.equal(config.readTunnelConfig(dir).mode, "quick");
});

test("a corrupt or unreadable file falls back to quick mode instead of throwing", (t) => {
  const dir = tempAgentDir(t);
  writeFileSync(join(dir, "pi-web-tunnel.json"), "{ this is not json", "utf8");
  const stored = config.readTunnelConfig(dir);
  assert.equal(stored.mode, "quick");
  assert.equal(stored.token, "");
  assert.equal(stored.autoStart, false);
});

test("hostnames: one exact DNS name, lower-cased, never a wildcard or an address", () => {
  const { normalizeTunnelHostname } = view;
  assert.equal(normalizeTunnelHostname("PI.Example.com"), "pi.example.com");
  assert.equal(normalizeTunnelHostname(" pi.example.com. "), "pi.example.com");
  assert.equal(normalizeTunnelHostname("pi.cwu.cc"), "pi.cwu.cc");
  assert.equal(normalizeTunnelHostname("*.example.com"), null);
  assert.equal(normalizeTunnelHostname("https://pi.example.com"), null);
  assert.equal(normalizeTunnelHostname("pi.example.com:8443"), null);
  assert.equal(normalizeTunnelHostname("pi.example.com/path"), null);
  assert.equal(normalizeTunnelHostname("localhost"), null);
  assert.equal(normalizeTunnelHostname("127.0.0.1"), null);
  assert.equal(normalizeTunnelHostname(""), null);
  assert.equal(normalizeTunnelHostname(undefined), null);
  assert.equal(normalizeTunnelHostname("example..com"), null);
  assert.equal(normalizeTunnelHostname(`${"a".repeat(64)}.example.com`), null);
});

test("tokens: one opaque blob, no whitespace and no shell punctuation", () => {
  const { normalizeTunnelToken } = view;
  assert.equal(normalizeTunnelToken(TOKEN), TOKEN);
  assert.equal(normalizeTunnelToken(`  ${TOKEN}\n`), TOKEN);
  assert.equal(normalizeTunnelToken("too-short"), null);
  assert.equal(normalizeTunnelToken(`${TOKEN} extra`), null);
  assert.equal(normalizeTunnelToken(`${TOKEN};rm -rf /`), null);
  assert.equal(normalizeTunnelToken(42), null);
});
