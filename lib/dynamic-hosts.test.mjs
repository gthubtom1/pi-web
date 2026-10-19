import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const hosts = await jiti.import("./dynamic-hosts.ts");
const sec = await jiti.import("./request-security.ts");

function req(host) {
  return new Request("http://x/api/sessions", { headers: { host } });
}

test("a tunnel host registered at runtime is trusted, then dropped when removed", () => {
  const host = "abc-123.trycloudflare.com";
  assert.equal(sec.isApiRequestHostAllowed(req(host)), false, "not trusted before registering");
  hosts.addDynamicHost(host);
  try {
    assert.equal(sec.isApiRequestHostAllowed(req(host)), true, "trusted while the tunnel is up");
    // Only the exact host, not any *.trycloudflare.com.
    assert.equal(sec.isApiRequestHostAllowed(req("other.trycloudflare.com")), false);
  } finally {
    hosts.removeDynamicHost(host);
  }
  assert.equal(sec.isApiRequestHostAllowed(req(host)), false, "dropped after removal");
});
