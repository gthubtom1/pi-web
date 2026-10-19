import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Loaded through jiti so the module's own extensionless imports resolve the way
// the app resolves them (tsconfig moduleResolution: "bundler"); bare
// `import("./path-security.ts")` only works while that file has no imports.
async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./path-security.ts");
}

test("rejects an existing path that escapes an allowed root through a symlink", async (t) => {
  const { isExistingPathWithinRoots, isPathWithinRoots } = await loadSubject();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-access-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  const link = path.join(allowed, "link");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  const target = path.join(link, "secret.txt");
  const roots = new Set([allowed]);

  assert.equal(isPathWithinRoots(target, roots), true);
  assert.equal(isExistingPathWithinRoots(target, roots), false);
});

test("rejects a `..` that climbs out beside a link's target", async (t) => {
  const { hasParentDirectorySegment, isExistingPathWithinRoots } = await loadSubject();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-access-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(path.join(outside, "linked"), { recursive: true });
  fs.symlinkSync(path.join(outside, "linked"), path.join(allowed, "link"), process.platform === "win32" ? "junction" : "dir");
  const roots = new Set([allowed]);

  // realpathSync reads `allowed/link/..` as `allowed`; opening it lists `outside`.
  const climb = `${allowed}${path.sep}link${path.sep}..`;
  assert.equal(isExistingPathWithinRoots(climb, roots), false);
  assert.equal(isExistingPathWithinRoots(path.join(allowed, "link"), new Set([allowed, outside])), true);

  assert.equal(hasParentDirectorySegment("/a/b/../c"), true);
  assert.equal(hasParentDirectorySegment("C:\\a\\..\\c"), true);
  assert.equal(hasParentDirectorySegment("/a/..b/c.."), false);
  if (process.platform !== "win32") assert.equal(hasParentDirectorySegment("/a/b\\..\\c"), false);
});

test("the agent dir's credential files are never served, even from an allowed root", async (t) => {
  const { createJiti } = await import("jiti");
  const { isFilePathAllowed, isExistingFilePathAllowed, isCredentialFile } = await createJiti(import.meta.url).import("./file-access.ts");
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-agent-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const home = path.dirname(agentDir);
  const tunnel = path.join(agentDir, "pi-web-tunnel.json");
  const pairing = path.join(agentDir, "pi-web-remote-pairing.json");
  const ordinary = path.join(agentDir, "settings.json");
  fs.writeFileSync(tunnel, JSON.stringify({ mode: "named", token: "secret" }));
  fs.writeFileSync(pairing, JSON.stringify({ lan: { code: "ABCD2345" } }));
  fs.writeFileSync(ordinary, "{}");

  // The home directory is an allowed root in this setup (a session was opened there).
  const roots = new Set([home]);

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    // The default agent dir is what the running server resolves, so this is the
    // path that matters: one env var, no per-call plumbing.
    assert.equal(isCredentialFile(tunnel), true);
    assert.equal(isCredentialFile(pairing), true);
    assert.equal(isFilePathAllowed(tunnel, roots), false);
    assert.equal(isExistingFilePathAllowed(tunnel, roots), false);
    assert.equal(isFilePathAllowed(pairing, roots), false);
    // A non-credential file beside them stays readable.
    assert.equal(isCredentialFile(ordinary), false);
    assert.equal(isFilePathAllowed(ordinary, roots), true);
    assert.equal(isExistingFilePathAllowed(ordinary, roots), true);
    // The deny list is scoped to the agent dir: same file name elsewhere is fine.
    const elsewhere = path.join(home, "backup", "pi-web-tunnel.json");
    assert.equal(isCredentialFile(elsewhere), false);
    // Lexical tricks do not escape the deny.
    assert.equal(isCredentialFile(path.join(agentDir, "..", path.basename(agentDir), "pi-web-tunnel.json")), true);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});
