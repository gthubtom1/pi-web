import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseAdvisorNotes, shouldInterrupt, formatAdvisorMessage } = await jiti.import("./advisor-runner.ts");

test("parses a clean JSON array", () => {
  const notes = parseAdvisorNotes('[{"severity":"concern","note":"wrong assumption"},{"severity":"nit","note":"style"}]', 4);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].severity, "concern");
  assert.equal(notes[1].note, "style");
});

test("strips code fences and extracts the array", () => {
  const notes = parseAdvisorNotes('Here you go:\n```json\n[{"severity":"blocker","note":"broken"}]\n```', 4);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].severity, "blocker");
});

test("empty array yields no notes", () => {
  assert.deepEqual(parseAdvisorNotes("[]", 4), []);
});

test("garbage yields no notes", () => {
  assert.deepEqual(parseAdvisorNotes("no json here", 4), []);
});

test("respects maxNotes", () => {
  const raw = JSON.stringify([
    { severity: "nit", note: "a" },
    { severity: "nit", note: "b" },
    { severity: "nit", note: "c" },
  ]);
  assert.equal(parseAdvisorNotes(raw, 2).length, 2);
});

test("shouldInterrupt honors none/blocker/concern", () => {
  const concern = [{ severity: "concern", note: "x" }];
  const blocker = [{ severity: "blocker", note: "x" }];
  const nit = [{ severity: "nit", note: "x" }];
  assert.equal(shouldInterrupt({ interruptOn: "none" }, blocker), false);
  assert.equal(shouldInterrupt({ interruptOn: "blocker" }, concern), false);
  assert.equal(shouldInterrupt({ interruptOn: "blocker" }, blocker), true);
  assert.equal(shouldInterrupt({ interruptOn: "concern" }, concern), true);
  assert.equal(shouldInterrupt({ interruptOn: "concern" }, nit), false);
});

test("formatAdvisorMessage lists severities", () => {
  const text = formatAdvisorMessage([{ severity: "concern", note: "watch out" }]);
  assert.ok(text.includes("[concern] watch out"));
});

test("a long transcript keeps the newest work, not the oldest", async () => {
  const { buildAdvisorTranscript } = await jiti.import("./advisor-runner.ts");
  const messages = [{ role: "user", content: "OLDEST-MARKER " + "a".repeat(9000), timestamp: 1 }];
  for (let i = 0; i < 16; i += 1) {
    messages.push({ role: "assistant", content: "mid " + "b".repeat(900), timestamp: 2 });
  }
  messages.push({ role: "user", content: "LATEST-MARKER", timestamp: 3 });
  const text = buildAdvisorTranscript(messages);
  assert.ok(text.includes("LATEST-MARKER"), "the turn just finished is what the advisor reviews");
  assert.ok(!text.includes("OLDEST-MARKER"), "the head is dropped first");
});
