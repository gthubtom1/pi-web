import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const secret = await jiti.import("./web-secret.ts");

function tempDir() {
  return mkdtempSync(join(tmpdir(), "pi-web-secret-"));
}

test("no password in source: an env value always wins", () => {
  const dir = tempDir();
  try {
    assert.equal(secret.resolveWebPassword({ env: { PI_WEB_PASSWORD: "chosen" }, agentDir: dir }), "chosen");
    // An explicit empty string disables auth.
    assert.equal(secret.resolveWebPassword({ env: { PI_WEB_PASSWORD: "" }, agentDir: dir }), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with no env password, a strong secret is generated, persisted 0600, and stable", () => {
  const dir = tempDir();
  try {
    const first = secret.resolveWebPassword({ env: {}, agentDir: dir });
    assert.ok(first.length >= 24, "secret is long");
    // Stored in the file, not in source.
    const fileValue = readFileSync(join(dir, "pi-web-secret"), "utf-8").trim();
    assert.equal(fileValue, first);
    if (process.platform !== "win32") {
      assert.equal(statSync(join(dir, "pi-web-secret")).mode & 0o777, 0o600);
    }
    // Stable across calls / restarts.
    assert.equal(secret.resolveWebPassword({ env: {}, agentDir: dir }), first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotation replaces the stored secret", () => {
  const dir = tempDir();
  try {
    const before = secret.resolveWebPassword({ env: {}, agentDir: dir });
    const rotated = secret.rotateStoredSecret({ agentDir: dir });
    assert.notEqual(rotated, before);
    assert.equal(secret.resolveWebPassword({ env: {}, agentDir: dir }), rotated);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isPasswordFromEnv distinguishes env-set from file-generated", () => {
  assert.equal(secret.isPasswordFromEnv({ PI_WEB_PASSWORD: "x" }), true);
  assert.equal(secret.isPasswordFromEnv({ PI_WEB_PASSWORD: "" }), true);
  assert.equal(secret.isPasswordFromEnv({}), false);
});

test("the settings switch turns authentication off without an env var, and back on", () => {
  const dir = tempDir();
  try {
    const secretValue = secret.resolveWebPassword({ env: {}, agentDir: dir });
    assert.ok(secretValue.length > 0, "auth on by default");

    const saved = secret.writeWebAuthSettings({ requirePassword: false }, dir);
    assert.equal(saved.requirePassword, false);
    assert.equal(secret.resolveWebPassword({ env: {}, agentDir: dir }), "", "auth off once switched off");
    assert.deepEqual(secret.describeWebAuth({ env: {}, agentDir: dir }), {
      required: false,
      source: "disabled",
      secretPath: join(dir, "pi-web-secret"),
    });

    secret.writeWebAuthSettings({ requirePassword: true }, dir);
    assert.equal(secret.resolveWebPassword({ env: {}, agentDir: dir }), secretValue, "the same secret comes back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the env var overrides the switch, and a corrupt auth file keeps auth on", () => {
  const dir = tempDir();
  try {
    secret.writeWebAuthSettings({ requirePassword: false }, dir);
    assert.equal(secret.resolveWebPassword({ env: { PI_WEB_PASSWORD: "env-pass" }, agentDir: dir }), "env-pass");
    assert.equal(secret.describeWebAuth({ env: { PI_WEB_PASSWORD: "env-pass" }, agentDir: dir }).source, "env");

    // Corrupt file: the safe default wins.
    writeFileSync(join(dir, "pi-web-auth.json"), "{ not json", "utf-8");
    assert.equal(secret.readWebAuthSettings(dir).requirePassword, true);
    assert.ok(secret.resolveWebPassword({ env: {}, agentDir: dir }).length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the panel can show, replace and randomize the remote password", () => {
  const dir = tempDir();
  try {
    const first = secret.resolveWebPassword({ env: {}, agentDir: dir });
    // reveal
    assert.equal(secret.readStoredSecret({ agentDir: dir }), first);

    // replace with a chosen one: it becomes effective and remote auth is required again
    secret.writeWebAuthSettings({ requirePassword: false }, dir);
    assert.equal(secret.resolveWebPassword({ env: {}, agentDir: dir }), "", "off");
    secret.setStoredSecret("my-own-password", { agentDir: dir });
    assert.equal(secret.resolveWebPassword({ env: {}, agentDir: dir }), "my-own-password");
    assert.equal(secret.readWebAuthSettings(dir).requirePassword, true, "setting one turns remote auth on");

    // too short is refused
    assert.throws(() => secret.setStoredSecret("12345", { agentDir: dir }), /at least 6/);

    // randomize: different value, still required
    const randomized = secret.randomizeStoredSecret({ agentDir: dir });
    assert.notEqual(randomized, "my-own-password");
    assert.ok(randomized.length >= 24);
    assert.equal(secret.resolveWebPassword({ env: {}, agentDir: dir }), randomized);

    // the env var still wins over the file
    assert.equal(secret.resolveWebPassword({ env: { PI_WEB_PASSWORD: "env" }, agentDir: dir }), "env");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
