import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const originalPassword = process.env.PI_WEB_PASSWORD;
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { proxy } = await jiti.import("../proxy.ts");
const { createWebSessionToken } = await jiti.import("./web-auth.ts");
const { getAuthRetryAfterMs, recordAuthFailure, recordAuthSuccess } = await import("./auth-throttle.ts");
const { addDynamicHost, removeDynamicHost } = await jiti.import("./dynamic-hosts.ts");

before(() => { process.env.PI_WEB_PASSWORD = "secret"; });
beforeEach(() => { recordAuthSuccess(); });
after(() => {
  recordAuthSuccess();
  if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
  else process.env.PI_WEB_PASSWORD = originalPassword;
});

// The password protects *remote* devices: these requests come from a phone on the
// LAN (Host is that device's route to us), which is what auth is for.
const REMOTE_HOST = "192.168.1.50:30141";
const REMOTE_ORIGIN = `http://${REMOTE_HOST}`;

function request(path, headers = {}) {
  return new NextRequest(`${REMOTE_ORIGIN}${path}`, {
    headers: { Host: REMOTE_HOST, ...headers },
  });
}

test("the local browser needs no password, and /login sends it home", () => {
  for (const host of ["127.0.0.1:30141", "localhost:30141", "[::1]:30141"]) {
    const page = proxy(new NextRequest(`http://${host}/?session=abc`, { headers: { Host: host } }));
    assert.equal(page.status, 200, host);
    assert.equal(page.headers.get("x-middleware-next"), "1");
    assert.equal(proxy(new NextRequest(`http://${host}/api/sessions`, { headers: { Host: host } })).status, 200, host);
    assert.equal(proxy(new NextRequest(`http://${host}/login`, { headers: { Host: host } })).status, 307, host);
  }
});

test("a LAN, Tailscale or tunnel host still needs the password", () => {
  for (const host of ["192.168.1.50:30141", "100.101.102.103:30141"]) {
    const response = proxy(new NextRequest(`http://${host}/`, { headers: { Host: host } }));
    assert.equal(response.status, 307, host);
    assert.match(String(response.headers.get("location")), /\/login/, host);
  }
  // A tunnel hostname is only trusted while its tunnel is up (dynamic-hosts).
  const tunnel = "abc-123.trycloudflare.com";
  addDynamicHost(tunnel);
  try {
    const response = proxy(new NextRequest(`https://${tunnel}/`, { headers: { Host: tunnel } }));
    assert.equal(response.status, 307);
    assert.match(String(response.headers.get("location")), /\/login/);
  } finally {
    removeDynamicHost(tunnel);
  }
});

test("redirects page navigation to the login page and preserves its query", () => {
  const response = proxy(request("/?session=abc"));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), `${REMOTE_ORIGIN}/login?next=%2F%3Fsession%3Dabc`);
});

test("accepts a signed session for pages", () => {
  const token = createWebSessionToken("secret");
  const response = proxy(request("/", { Cookie: `pi_web_session=${token}` }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

test("keeps Basic Auth compatibility for APIs but not pages", () => {
  const authorization = `Basic ${Buffer.from("pi:secret").toString("base64")}`;
  assert.equal(proxy(request("/api/sessions", { Authorization: authorization })).status, 200);
  assert.equal(proxy(request("/", { Authorization: authorization })).status, 307);
  assert.equal(proxy(request("/api/sessions")).status, 401);
});

test("leaves the login endpoint reachable without a session", () => {
  assert.equal(proxy(request("/login")).status, 200);
  assert.equal(proxy(request("/api/web-auth")).status, 200);
});

function basic(password) {
  return `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`;
}

test("a wrong Basic password blocks further attempts, even with the right password", () => {
  assert.equal(proxy(request("/api/sessions", { Authorization: basic("guess") })).status, 401);
  assert.ok(getAuthRetryAfterMs() > 0);

  for (const path of ["/api/sessions", "/api/web-auth"]) {
    const response = proxy(request(path, { Authorization: basic("secret") }));
    assert.equal(response.status, 429, path);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("GET /api/web-auth cannot be used to check Basic passwords without the throttle", () => {
  assert.equal(proxy(request("/api/web-auth", { Authorization: basic("guess") })).status, 200);
  assert.ok(getAuthRetryAfterMs() > 0);
  assert.equal(proxy(request("/api/web-auth", { Authorization: basic("guess-2") })).status, 429);
});

test("a signed session keeps working while Basic attempts are blocked", () => {
  proxy(request("/api/sessions", { Authorization: basic("guess") }));
  const token = createWebSessionToken("secret");
  const response = proxy(request("/api/sessions", {
    Authorization: basic("guess"),
    Cookie: `pi_web_session=${token}`,
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

test("only Basic credentials count as password attempts", () => {
  assert.equal(proxy(request("/api/sessions", { Authorization: "Bearer token" })).status, 401);
  assert.equal(getAuthRetryAfterMs(), 0);
});

test("a Basic success does not reset earlier failures", () => {
  recordAuthFailure(Date.now() - 2_000);
  assert.equal(getAuthRetryAfterMs(), 0);
  assert.equal(proxy(request("/api/sessions", { Authorization: basic("secret") })).status, 200);

  assert.equal(proxy(request("/api/sessions", { Authorization: basic("guess") })).status, 401);
  // The second failure in a row doubles the block instead of starting over.
  assert.ok(getAuthRetryAfterMs() > 1_000);
});
