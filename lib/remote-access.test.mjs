import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const remote = await jiti.import("./remote-access.ts");

test("recognises the Tailscale CGNAT range 100.64.0.0/10", () => {
  assert.equal(remote.isTailscaleAddress("100.64.0.1"), true);
  assert.equal(remote.isTailscaleAddress("100.127.255.254"), true);
  assert.equal(remote.isTailscaleAddress("100.63.255.255"), false);
  assert.equal(remote.isTailscaleAddress("100.128.0.0"), false);
  assert.equal(remote.isTailscaleAddress("192.168.0.1"), false);
});

test("recognises RFC1918 LAN addresses", () => {
  assert.equal(remote.isPrivateLanAddress("10.1.2.3"), true);
  assert.equal(remote.isPrivateLanAddress("172.16.0.1"), true);
  assert.equal(remote.isPrivateLanAddress("172.31.255.255"), true);
  assert.equal(remote.isPrivateLanAddress("172.32.0.1"), false);
  assert.equal(remote.isPrivateLanAddress("192.168.1.1"), true);
  assert.equal(remote.isPrivateLanAddress("8.8.8.8"), false);
});

test("listRemoteAddresses returns lan/tailscale arrays without loopback or link-local", () => {
  const { lan, tailscale } = remote.listRemoteAddresses();
  assert.ok(Array.isArray(lan) && Array.isArray(tailscale));
  for (const item of [...lan, ...tailscale]) {
    assert.equal(item.address.startsWith("127."), false);
    assert.equal(item.address.startsWith("169.254."), false);
  }
});
