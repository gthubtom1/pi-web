import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const p = await jiti.import("./local-proxy.ts");

test("reads a proxy from the environment (http or socks), normalising a bare host:port", () => {
  assert.equal(p.proxyFromEnv({ HTTPS_PROXY: "http://127.0.0.1:7890" }), "http://127.0.0.1:7890");
  assert.equal(p.proxyFromEnv({ https_proxy: "socks5://127.0.0.1:1080" }), "socks5://127.0.0.1:1080");
  assert.equal(p.proxyFromEnv({ ALL_PROXY: "127.0.0.1:7897" }), "http://127.0.0.1:7897");
  assert.equal(p.proxyFromEnv({ NO_PROXY: "x" }), null);
});

test("env proxy wins and skips detection", async () => {
  assert.equal(await p.resolveOutboundProxy({ HTTPS_PROXY: "http://127.0.0.1:9999" }), "http://127.0.0.1:9999");
});

test("detects a live local proxy port, and returns null when none is listening", async () => {
  // Open a real listener on a random port, then probe it.
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const found = await p.detectLocalProxyPort([port], "127.0.0.1", 500);
    assert.equal(found, `http://127.0.0.1:${port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
  // A port nothing listens on -> null.
  assert.equal(await p.detectLocalProxyPort([1], "127.0.0.1", 200), null);
});
