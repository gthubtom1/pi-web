import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// The fixed domain's state transitions that never touch the network. Anything that
// would spawn or download cloudflared is covered by tunnel.test.mjs, which points
// the resolver at an unreachable URL.
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-tunnel-named-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url);
const config = await jiti.import("./tunnel-config.ts");
const tunnel = await jiti.import("./tunnel.ts");

test.after(() => {
  tunnel.stopTunnel();
  rmSync(agentDir, { recursive: true, force: true });
});

const TOKEN = "eyJhIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoiLCJ0IjoiMTIzNDU2Nzg5MCJ9";

test("autoStart stays off unless the operator turned it on", () => {
  config.writeTunnelConfig({ version: 1, mode: "quick", token: "", hostname: "", autoStart: false }, agentDir);
  assert.equal(tunnel.autoStartTunnel(30141), null);
  assert.equal(tunnel.getTunnelState().status, "stopped");
});

test("stopping keeps the chosen mode and the autoStart switch", () => {
  config.writeTunnelConfig(
    { version: 1, mode: "named", token: TOKEN, hostname: "pi.example.com", autoStart: true },
    agentDir,
  );
  const stopped = tunnel.stopTunnel();
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.mode, "named");
  assert.equal(stopped.autoStart, true);
  assert.equal(stopped.url, null);
  assert.equal(stopped.hostname, null);
  assert.equal(stopped.restarts, 0);

  config.writeTunnelConfig({ version: 1, mode: "quick", token: "", hostname: "", autoStart: false }, agentDir);
  assert.equal(tunnel.getTunnelState().mode, "quick");
  assert.equal(tunnel.getTunnelState().autoStart, false);
});
