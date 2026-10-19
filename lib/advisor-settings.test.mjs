import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { normalizeAdvisorSettings } = await jiti.import("./advisor-settings.ts");

test("defaults: off, no model, concern, 8, 4", () => {
  const s = normalizeAdvisorSettings({});
  assert.equal(s.mode, "off");
  assert.equal(s.provider, "");
  assert.equal(s.modelId, "");
  assert.equal(s.interruptOn, "concern");
  assert.equal(s.autoMinToolCalls, 8);
  assert.equal(s.maxNotes, 4);
});

test("clamps and rejects invalid enums", () => {
  const s = normalizeAdvisorSettings({ mode: "bogus", interruptOn: "x", autoMinToolCalls: 999, maxNotes: -3 });
  assert.equal(s.mode, "off");
  assert.equal(s.interruptOn, "concern");
  assert.equal(s.autoMinToolCalls, 100);
  assert.equal(s.maxNotes, 1);
});

test("keeps valid values", () => {
  const s = normalizeAdvisorSettings({ mode: "auto", provider: "p", modelId: "m", interruptOn: "blocker", autoMinToolCalls: 3, maxNotes: 2 });
  assert.deepEqual([s.mode, s.provider, s.modelId, s.interruptOn, s.autoMinToolCalls, s.maxNotes], ["auto", "p", "m", "blocker", 3, 2]);
});
