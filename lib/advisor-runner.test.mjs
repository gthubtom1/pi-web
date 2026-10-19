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

// End-to-end mechanics with a stub session: model choice, transcript, parsing,
// abort/error degradation. No network, no real model.
const { runAdvisorReview } = await jiti.import("./advisor-runner.ts");

function stubSession({ reply, model = { id: "m", provider: "p", api: "openai-completions" }, runtimeModel } = {}) {
  const calls = [];
  const session = {
    agent: {
      state: { model, messages: [{ role: "user", content: "reverse the sandbox target", timestamp: 1 }] },
      getApiKey: async () => "key-1",
      streamFunction: async (used, context, options) => {
        calls.push({ used, context, options });
        return { result: async () => reply };
      },
    },
    modelRuntime: { getModel: () => runtimeModel },
  };
  return { session, calls };
}

const replyMessage = (text, stopReason = "stop") => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason,
  usage: { input: 100, output: 20 },
});

test("a review uses the main model, sends the transcript and returns parsed notes", async () => {
  const { session, calls } = stubSession({ reply: replyMessage('[{"severity":"concern","note":"claims success without proof"}]') });
  const result = await runAdvisorReview(session, { mode: "auto", provider: "", modelId: "", interruptOn: "concern", autoMinToolCalls: 8, maxNotes: 4 });
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0].note, "claims success without proof");
  assert.deepEqual(result.usage, { input: 100, output: 20 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].used.id, "m", "main model when none is configured");
  assert.ok(calls[0].options.apiKey === "key-1");
  assert.ok(JSON.stringify(calls[0].context).includes("reverse the sandbox target"), "the transcript reaches the reviewer");
});

test("a configured advisor model is used; an unresolvable one means no review at all", async () => {
  const chosen = { id: "cheap", provider: "p2", api: "openai-completions" };
  const ok = stubSession({ reply: replyMessage("[]"), runtimeModel: chosen });
  await runAdvisorReview(ok.session, { mode: "auto", provider: "p2", modelId: "cheap", interruptOn: "concern", autoMinToolCalls: 8, maxNotes: 4 });
  assert.equal(ok.calls[0].used.id, "cheap");

  const missing = stubSession({ reply: replyMessage("[]"), runtimeModel: undefined });
  const result = await runAdvisorReview(missing.session, { mode: "auto", provider: "p2", modelId: "gone", interruptOn: "concern", autoMinToolCalls: 8, maxNotes: 4 });
  assert.deepEqual(result.notes, []);
  assert.equal(missing.calls.length, 0, "never falls back to the (possibly expensive) main model");
});

test("an errored or aborted review yields no notes and never throws", async () => {
  const errored = stubSession({ reply: replyMessage("boom", "error") });
  assert.deepEqual((await runAdvisorReview(errored.session, { mode: "manual", provider: "", modelId: "", interruptOn: "none", autoMinToolCalls: 8, maxNotes: 4 })).notes, []);

  const throwing = { agent: { state: { model: undefined, messages: [] } } };
  assert.deepEqual((await runAdvisorReview(throwing, { mode: "manual", provider: "", modelId: "", interruptOn: "none", autoMinToolCalls: 8, maxNotes: 4 })).notes, []);

  const aborted = stubSession({ reply: replyMessage("x", "aborted") });
  assert.deepEqual((await runAdvisorReview(aborted.session, { mode: "manual", provider: "", modelId: "", interruptOn: "none", autoMinToolCalls: 8, maxNotes: 4 })).notes, []);
});

test("cancelling the review aborts the request instead of waiting for the model", async () => {
  const controller = new AbortController();
  const session = {
    agent: {
      state: { model: { id: "m", provider: "p", api: "openai-completions" }, messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      getApiKey: async () => undefined,
      streamFunction: async (_model, _context, options) => {
        // Never resolves on its own: only the review's abort signal ends it. A real
        // provider rejects an already-aborted signal, so the stub does too.
        return {
          result: () => new Promise((resolve) => {
            if (options.signal.aborted) { resolve(replyMessage("", "aborted")); return; }
            options.signal.addEventListener("abort", () => resolve(replyMessage("", "aborted")), { once: true });
          }),
        };
      },
    },
  };
  const pending = runAdvisorReview(session, { mode: "auto", provider: "", modelId: "", interruptOn: "concern", autoMinToolCalls: 8, maxNotes: 4 }, controller.signal);
  controller.abort();
  assert.deepEqual((await pending).notes, []);
});
