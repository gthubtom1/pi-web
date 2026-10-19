import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const p = await jiti.import("./personas.ts");

function tempDir() {
  return mkdtempSync(join(tmpdir(), "personas-"));
}

test("create, list, read text; first persona becomes default", async () => {
  const dir = tempDir();
  try {
    const a = await p.savePersona({ name: "A", personality: "aaa" }, dir);
    assert.ok(a.id);
    const list = p.listPersonas(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].personality.trim(), "aaa");
    assert.equal(p.readPersonasIndex(dir).defaultPersonaId, a.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each persona is its own file (no cross-write), index stays metadata only", async () => {
  const dir = tempDir();
  try {
    const a = await p.savePersona({ name: "A", personality: "aaa" }, dir);
    const b = await p.savePersona({ name: "B", personality: "bbb" }, dir);
    assert.ok(existsSync(join(dir, "personas", `${a.id}.md`)));
    assert.ok(existsSync(join(dir, "personas", `${b.id}.md`)));
    // Editing B does not change A.
    await p.savePersona({ id: b.id, personality: "bbb2" }, dir);
    assert.equal(p.readPersonaText(dir, a.id).trim(), "aaa");
    assert.equal(p.readPersonaText(dir, b.id).trim(), "bbb2");
    // The index holds no persona text.
    const idx = p.readPersonasIndex(dir);
    assert.equal(JSON.stringify(idx).includes("aaa"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rename / duplicate / delete / set-default", async () => {
  const dir = tempDir();
  try {
    const a = await p.savePersona({ name: "A", personality: "aaa" }, dir);
    await p.renamePersona(a.id, "Renamed", dir);
    assert.equal(p.readPersonasIndex(dir).personas[0].name, "Renamed");
    const dup = await p.duplicatePersona(a.id, dir);
    assert.notEqual(dup.id, a.id);
    assert.equal(p.readPersonaText(dir, dup.id).trim(), "aaa");
    await p.setDefaultPersona(dup.id, dir);
    assert.equal(p.readPersonasIndex(dir).defaultPersonaId, dup.id);
    await p.deletePersona(dup.id, dir);
    // Deleting the default falls back to the first remaining persona.
    assert.equal(p.readPersonasIndex(dir).defaultPersonaId, a.id);
    assert.equal(existsSync(join(dir, "personas", `${dup.id}.md`)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolvePersonaId: own pick wins, null means none, missing falls back", async () => {
  const dir = tempDir();
  try {
    const a = await p.savePersona({ name: "A", personality: "aaa" }, dir);
    const b = await p.savePersona({ name: "B", personality: "bbb" }, dir);
    await p.setDefaultPersona(a.id, dir);
    // Own pick wins over default.
    assert.equal(p.resolvePersonaId(dir, b.id), b.id);
    // Explicit null -> none (rules only), regardless of default.
    assert.equal(p.resolvePersonaId(dir, null), null);
    // undefined (never chose) -> default.
    assert.equal(p.resolvePersonaId(dir, undefined), a.id);
    // A deleted id falls back to none.
    assert.equal(p.resolvePersonaId(dir, "p_gone"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt index reads as empty, never throws", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "personas.json"), "{not json", "utf-8");
    assert.deepEqual(p.readPersonasIndex(dir).personas, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two saves racing each other both survive (index is re-read under the lock)", async () => {
  const dir = tempDir();
  try {
    const results = await Promise.all([
      p.savePersona({ name: "A", personality: "aaa" }, dir),
      p.savePersona({ name: "B", personality: "bbb" }, dir),
      p.savePersona({ name: "C", personality: "ccc" }, dir),
    ]);
    const ids = new Set(results.map((r) => r.id));
    assert.equal(ids.size, 3);
    const index = p.readPersonasIndex(dir);
    assert.deepEqual(new Set(index.personas.map((x) => x.id)), ids, "no entry was lost");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
