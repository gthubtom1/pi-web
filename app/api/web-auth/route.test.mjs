import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

// A LAN guest (Host is their route to us). The local browser (127.0.0.1) is a
// separate case and never signs in.
const LAN_HOST = "192.168.1.50:30141";
const LAN_ORIGIN = `http://${LAN_HOST}`;

const originalPassword = process.env.PI_WEB_PASSWORD;
const agentDir = mkdtempSync(join(tmpdir(), "web-auth-route-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, POST, DELETE } = await jiti.import("./route.ts");
const pairing = await jiti.import("../../../lib/remote-pairing.ts");
const { recordAuthSuccess } = await import("../../../lib/auth-throttle.ts");

before(() => {
  // Pairing-only mode: no operator password, so the LAN code is the credential.
  delete process.env.PI_WEB_PASSWORD;
  pairing.updateRemotePairing((state) => {
    state.lan = { enabled: true, code: "LANCODE1", secret: "lan-secret-0123456789abcdef" };
    state.public = { enabled: true, code: "PUBC0DE", secret: "public-secret-0123456789ab" };
  }, agentDir);
});
beforeEach(() => { recordAuthSuccess(); });
after(() => {
  recordAuthSuccess();
  if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
  else process.env.PI_WEB_PASSWORD = originalPassword;
  rmSync(agentDir, { recursive: true, force: true });
});

function request(method, body, headers = {}, host = LAN_HOST, origin = LAN_ORIGIN) {
  return new NextRequest(`${origin}/api/web-auth`, {
    method,
    headers: {
      Host: host,
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("signs in with the LAN pairing code and reports the session", async () => {
  let response = await POST(request("POST", { code: "WRONGCODE" }));
  assert.equal(response.status, 401);
  assert.equal(response.headers.has("set-cookie"), false);

  recordAuthSuccess();
  response = await POST(request("POST", { code: "lancODE1" }));
  assert.equal(response.status, 200, "the code is case-insensitive");
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /^pi_web_session=v1\./);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Path=\//i);

  const cookiePair = cookie.split(";", 1)[0];
  response = await GET(request("GET", undefined, { Cookie: cookiePair }));
  const state = await response.json();
  assert.equal(state.enabled, true);
  assert.equal(state.authenticated, true);
  assert.equal(state.scope, "lan");
});

test("a QR secret pairs the same device as the code", async () => {
  const response = await POST(request("POST", { secret: "public-secret-0123456789ab" }));
  assert.equal(response.status, 401, "the LAN entry does not accept the public secret");
  recordAuthSuccess();
  const lan = await POST(request("POST", { secret: "lan-secret-0123456789abcdef" }));
  assert.equal(lan.status, 200);
  assert.match(lan.headers.get("set-cookie"), /^pi_web_session=v1\./);
});

test("a failure blocks further attempts, even the right code", async () => {
  assert.equal((await POST(request("POST", { code: "WRONGCODE" }))).status, 401);
  const blocked = await POST(request("POST", { code: "LANCODE1" }));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "1");
});

test("the local browser is let in without anything", async () => {
  const response = await GET(request("GET", undefined, {}, "127.0.0.1:30141", "http://127.0.0.1:30141"));
  assert.deepEqual(await response.json(), {
    enabled: false,
    authenticated: true,
    scope: "lan",
    passwordEnabled: false,
    pairingEnabled: true,
  });
});

test("a disabled entry needs no code at all", async () => {
  pairing.updateRemotePairing((state) => { state.lan.enabled = false; }, agentDir);
  try {
    const state = await (await GET(request("GET"))).json();
    assert.equal(state.enabled, false);
    assert.equal(state.authenticated, true);
    // A code typed anyway still works (it sets the cookie) and does not fail.
    assert.equal((await POST(request("POST", { code: "anything" }))).status, 200);
  } finally {
    pairing.updateRemotePairing((state) => { state.lan.enabled = true; }, agentDir);
  }
});

test("the operator password still signs in, and still throttles", async () => {
  process.env.PI_WEB_PASSWORD = "correct horse battery staple";
  try {
    let response = await POST(request("POST", { password: "wrong" }));
    assert.equal(response.status, 401);
    recordAuthSuccess();
    response = await POST(request("POST", { password: "correct horse battery staple" }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /^pi_web_session=v1\./);
  } finally {
    delete process.env.PI_WEB_PASSWORD;
  }
});

test("logout clears the session cookie", async () => {
  const response = await DELETE(request("DELETE"));
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /^pi_web_session=;/);
  assert.match(cookie, /Max-Age=0/i);
});

test("rejects cross-origin login attempts", async () => {
  const response = await POST(new NextRequest(`${LAN_ORIGIN}/api/web-auth`, {
    method: "POST",
    headers: {
      Host: LAN_HOST,
      Origin: "http://evil.example",
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code: "LANCODE1" }),
  }));
  assert.equal(response.status, 403);
});
