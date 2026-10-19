import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// A tunnel test that never needs the network: it points the resolver at a
// bogus binary and checks the state machine settles to "error" (graceful),
// never hanging, and that stop/uninstall reset state.
const agentDir = mkdtempSync(join(tmpdir(), "tunnel-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_WEB_CLOUDFLARED_URL = "http://127.0.0.1:1/nope"; // unreachable
process.env.HTTPS_PROXY = "http://127.0.0.1:1"; // force a fast-failing proxy too

const jiti = createJiti(import.meta.url);

test("start returns 'starting' immediately and settles to a terminal state", async () => {
  const t = await jiti.import("./tunnel.ts");
  const s0 = t.startTunnel(30141);
  assert.equal(s0.status, "starting");
  let s = s0;
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    s = t.getTunnelState();
    if (s.status === "running" || s.status === "error") break;
  }
  assert.ok(s.status === "running" || s.status === "error", "must settle, never hang");
  // This environment cannot reach Cloudflare, so it should be a clean error.
  assert.equal(s.status, "error");
  assert.ok(s.error && s.error.length > 0);

  const stopped = t.stopTunnel();
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.url, null);
  rmSync(agentDir, { recursive: true, force: true });
});

test("a bogus system binary reports an error rather than throwing to the caller", async () => {
  const t = await jiti.import("./tunnel.ts");
  process.env.PI_WEB_CLOUDFLARED = join(agentDir, "does-not-exist");
  // ensureCloudflared rejects the missing path and falls back; start still must not throw.
  assert.doesNotThrow(() => t.startTunnel(30141));
  t.stopTunnel();
});
