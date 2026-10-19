import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const sp = await jiti.import("./session-persona.ts");

function entry(data) {
  return { type: "custom", customType: sp.SESSION_PERSONA_TYPE, data, id: "x", parentId: null, timestamp: "" };
}

test("no entry -> undefined (follow the global default)", () => {
  assert.equal(sp.readSessionPersona([]), undefined);
  assert.equal(sp.readSessionPersona([{ type: "message" }]), undefined);
});

test("newest entry wins; null means no persona", () => {
  const entries = [
    entry({ version: 1, personaId: "p_a" }),
    entry({ version: 1, personaId: "p_b" }),
  ];
  assert.equal(sp.readSessionPersona(entries), "p_b");
  const withNull = [...entries, entry({ version: 1, personaId: null })];
  assert.equal(sp.readSessionPersona(withNull), null);
});

test("invalid ids and wrong versions are ignored", () => {
  assert.equal(sp.readSessionPersona([entry({ version: 2, personaId: "p_a" })]), undefined);
  assert.equal(sp.readSessionPersona([entry({ version: 1, personaId: "bad id!" })]), undefined);
});
