import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { rewindSessionInPlace } = await jiti.import("./session-rewind.ts");

function makeFile(lines) {
  const dir = mkdtempSync(join(tmpdir(), "rewind-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  return file;
}

const HEADER = { type: "session", id: "sess-1", cwd: "/tmp" };

test("rewind removes the target entry and everything after it", () => {
  const file = makeFile([
    HEADER,
    { type: "message", id: "e1", role: "user" },
    { type: "message", id: "e2", role: "assistant" },
    { type: "message", id: "e3", role: "user" },
    { type: "message", id: "e4", role: "assistant" },
  ]);
  const result = rewindSessionInPlace(file, "e3");
  assert.equal(result.success, true);
  assert.equal(result.removedCount, 2);
  const lines = readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.type === "session" ? "header" : l.id), ["header", "e1", "e2"]);
  rmSync(file, { force: true });
});

test("rewind never removes the session header", () => {
  const file = makeFile([HEADER, { type: "message", id: "e1" }]);
  const result = rewindSessionInPlace(file, "sess-1");
  assert.equal(result.success, false);
  const lines = readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  rmSync(file, { force: true });
});

test("rewind refuses an unknown entry and leaves the file intact", () => {
  const file = makeFile([HEADER, { type: "message", id: "e1" }]);
  const before = readFileSync(file, "utf-8");
  const result = rewindSessionInPlace(file, "nope");
  assert.equal(result.success, false);
  assert.equal(readFileSync(file, "utf-8"), before);
  rmSync(file, { force: true });
});

test("rewind to the first message keeps only the header", () => {
  const file = makeFile([HEADER, { type: "message", id: "e1" }, { type: "message", id: "e2" }]);
  const result = rewindSessionInPlace(file, "e1");
  assert.equal(result.success, true);
  assert.equal(result.removedCount, 2);
  const lines = readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "session");
  rmSync(file, { force: true });
});

test("refuses when a surviving compaction entry points into the removed tail", () => {
  const dir = mkdtempSync(join(tmpdir(), "rewind-"));
  try {
    const file = join(dir, "s.jsonl");
    const header = { type: "session", id: "h", timestamp: "t", cwd: "/x" };
    const u1 = { type: "message", id: "u1", parentId: null, message: { role: "user", content: "one" } };
    // A compaction that survives the cut but whose firstKeptEntryId lives after it.
    const comp = { type: "compaction", id: "c1", parentId: "u1", summary: "s", firstKeptEntryId: "a9" };
    const u2 = { type: "message", id: "u2", parentId: "c1", message: { role: "user", content: "two" } };
    const a9 = { type: "message", id: "a9", parentId: "u2", message: { role: "assistant", content: [] } };
    const lines = [header, u1, comp, u2, a9].map((e) => JSON.stringify(e));
    writeFileSync(file, `${lines.join("\n")}\n`);

    const result = rewindSessionInPlace(file, "u2");
    assert.equal(result.success, false);
    assert.match(String(result.reason), /referenced entry/);
    assert.equal(readFileSync(file, "utf-8"), `${lines.join("\n")}\n`, "the file is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// "Delete this reply" (mode: "reply"): exactly one assistant reply, keeping the
// question and every earlier tool result.
const { checkPurgeReplyTarget } = await jiti.import("./session-rewind.ts");
const userTurn = { type: "message", id: "u1", parentId: null, message: { role: "user", content: "reverse this app" } };
const refusal = { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "I can't help with that." }] } };

test("a last refusal can be deleted on its own, and its question comes back as the draft", () => {
  const file = makeFile([HEADER, userTurn, refusal]);
  const check = checkPurgeReplyTarget(file, "a1");
  assert.equal(check.ok, true);
  assert.equal(check.draft, "reverse this app");
  const result = rewindSessionInPlace(file, "a1");
  assert.equal(result.success, true);
  const kept = readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(kept.map((e) => (e.type === "session" ? "session" : e.id)), ["session", "u1"], "question survives, reply is gone");
});

test("tool results above the refusal survive the purge", () => {
  const file = makeFile([
    HEADER,
    userTurn,
    { type: "message", id: "a0", parentId: "u1", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "t1", name: "read", args: {} }] } },
    { type: "message", id: "r1", parentId: "a0", message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "evidence" }] } },
    refusal,
  ]);
  assert.equal(checkPurgeReplyTarget(file, "a1").ok, true);
  rewindSessionInPlace(file, "a1");
  const kept = readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(kept.map((e) => (e.type === "session" ? "session" : e.id)), ["session", "u1", "a0", "r1"]);
});

test("a reply that called tools is refused", () => {
  const file = makeFile([
    HEADER,
    userTurn,
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "t1", name: "bash", args: {} }] } },
  ]);
  const check = checkPurgeReplyTarget(file, "a1");
  assert.equal(check.ok, false);
  assert.match(String(check.reason), /without tool calls/);
});

test("only the last reply may be deleted", () => {
  const file = makeFile([HEADER, userTurn, refusal, { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "again" } }]);
  const check = checkPurgeReplyTarget(file, "a1");
  assert.equal(check.ok, false);
  assert.match(String(check.reason), /last reply/);
});

test("a user message is not a reply", () => {
  const file = makeFile([HEADER, userTurn, refusal]);
  assert.equal(checkPurgeReplyTarget(file, "u1").ok, false);
});

test("a missing target is refused", () => {
  const file = makeFile([HEADER, userTurn, refusal]);
  assert.equal(checkPurgeReplyTarget(file, "nope").ok, false);
});
