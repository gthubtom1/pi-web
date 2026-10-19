import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const s = await jiti.import("./persona-inject-settings.ts");

function tempDir() {
  return mkdtempSync(join(tmpdir(), "pinj-"));
}

test("defaults to every-turn", () => {
  const dir = tempDir();
  try {
    assert.equal(s.readPersonaInjectSettings(dir).mode, "every-turn");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writes and reads cached; rejects unknown modes", () => {
  const dir = tempDir();
  try {
    assert.equal(s.writePersonaInjectSettings({ mode: "cached" }, dir).mode, "cached");
    assert.equal(s.readPersonaInjectSettings(dir).mode, "cached");
    // Unknown falls back to every-turn.
    assert.equal(s.writePersonaInjectSettings({ mode: "bogus" }, dir).mode, "every-turn");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalize accepts only the two known modes", () => {
  assert.equal(s.normalizePersonaInjectSettings({ mode: "cached" }).mode, "cached");
  assert.equal(s.normalizePersonaInjectSettings({ mode: "every-turn" }).mode, "every-turn");
  assert.equal(s.normalizePersonaInjectSettings({}).mode, "every-turn");
  assert.equal(s.normalizePersonaInjectSettings(null).mode, "every-turn");
});
