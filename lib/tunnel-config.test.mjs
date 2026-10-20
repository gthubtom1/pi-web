import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// The tunnel's own settings are one switch now (the named/fixed-domain mode was
// removed), and the state machine never spawns anything in these tests.
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-tunnel-config-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url);
const config = await jiti.import("./tunnel-config.ts");
const tunnel = await jiti.import("./tunnel.ts");

test.after(() => {
  tunnel.stopTunnel();
  rmSync(agentDir, { recursive: true, force: true });
});

test("a missing file means autoStart off", () => {
  assert.deepEqual(config.readTunnelConfig(agentDir), { version: 1, autoStart: false });
});

test("autoStart round-trips and is the only thing the file holds", () => {
  config.updateTunnelConfig((next) => { next.autoStart = true; }, agentDir);
  assert.equal(config.readTunnelConfig(agentDir).autoStart, true);
  const bytes = readFileSync(config.tunnelConfigPath(agentDir), "utf8");
  assert.match(bytes, /"autoStart": true/);
  assert.doesNotMatch(bytes, /token|hostname|mode/, "no credential and no mode live here any more");

  config.updateTunnelConfig((next) => { next.autoStart = false; }, agentDir);
  assert.equal(config.readTunnelConfig(agentDir).autoStart, false);
});

test("a file left by the removed fixed-domain mode reads as autoStart alone and is rewritten clean", () => {
  writeFileSync(
    join(agentDir, config.TUNNEL_CONFIG_FILE_NAME),
    JSON.stringify({
      version: 1,
      mode: "named",
      token: "eyJhIjoibGVnYWN5In0",
      hostname: "pi.example.com",
      autoStart: true,
    }),
    "utf8",
  );
  // Reading drops everything but the switch...
  assert.deepEqual(config.readTunnelConfig(agentDir), { version: 1, autoStart: true });
  // ...and the next write removes the leftover credential from disk.
  config.updateTunnelConfig(() => {}, agentDir);
  const bytes = readFileSync(config.tunnelConfigPath(agentDir), "utf8");
  assert.doesNotMatch(bytes, /TOKEN|legacy|pi\.example\.com/);
});

test("a corrupt file falls back to autoStart off instead of throwing", () => {
  writeFileSync(join(agentDir, config.TUNNEL_CONFIG_FILE_NAME), "{ not json", "utf8");
  assert.deepEqual(config.readTunnelConfig(agentDir), { version: 1, autoStart: false });
});

test("autoStart stays off unless the operator turned it on", () => {
  config.writeTunnelConfig({ version: 1, autoStart: false }, agentDir);
  assert.equal(tunnel.autoStartTunnel(30141), null);
  assert.equal(tunnel.getTunnelState().status, "stopped");
});

test("stopping keeps no tunnel behind: state is reset and the switch comes from the file", () => {
  config.writeTunnelConfig({ version: 1, autoStart: true }, agentDir);
  const stopped = tunnel.stopTunnel();
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.autoStart, true);
  assert.equal(stopped.url, null);
  assert.equal(stopped.hostname, null);
  assert.equal(stopped.restarts, 0);
  config.writeTunnelConfig({ version: 1, autoStart: false }, agentDir);
  assert.equal(tunnel.getTunnelState().autoStart, false);
});
