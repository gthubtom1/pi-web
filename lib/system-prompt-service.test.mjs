import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const svc = await jiti.import("./system-prompt-service.ts");
const personas = await jiti.import("./personas.ts");

function tempDir(prefix = "sp-svc-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function makePersona(agentDir, name, text) {
  const meta = await personas.savePersona({ name, personality: text }, agentDir);
  return meta.id;
}

test("no persona and no rules -> nothing injected (original prompt)", () => {
  const agentDir = tempDir();
  try {
    assert.equal(svc.buildPersonaInjection(null, agentDir), "");
    const ext = svc.createPersonalityExtension(() => null, agentDir);
    let handler;
    ext({ on: (e, fn) => { if (e === "before_agent_start") handler = fn; } });
    assert.equal(handler({ systemPrompt: "BASE" }), undefined);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("persona is injected; rules are always injected globally", async () => {
  const agentDir = tempDir();
  try {
    const id = await makePersona(agentDir, "DeepSeek", "You are DeepSeek flavored.");
    svc.saveGlobalRules("Always answer in Chinese.", agentDir);
    const text = svc.buildPersonaInjection(id, agentDir);
    const p = text.indexOf("<personality>");
    const r = text.indexOf("<generic-rules>");
    assert.ok(p >= 0 && r > p);
    assert.ok(text.includes("DeepSeek flavored."));
    assert.ok(text.includes("Always answer in Chinese."));

    // A conversation with NO persona still gets the global rules.
    const onlyRules = svc.buildPersonaInjection(null, agentDir);
    assert.equal(onlyRules.includes("<personality>"), false);
    assert.ok(onlyRules.includes("<generic-rules>"));
    assert.ok(onlyRules.includes("Always answer in Chinese."));
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("the extension reads the persona per call, so two conversations differ", async () => {
  const agentDir = tempDir();
  try {
    const a = await makePersona(agentDir, "A", "PERSONA-A");
    const b = await makePersona(agentDir, "B", "PERSONA-B");
    const make = (id) => {
      const ext = svc.createPersonalityExtension(() => id, agentDir);
      let handler;
      ext({ on: (e, fn) => { if (e === "before_agent_start") handler = fn; } });
      return handler({ systemPrompt: "BASE" }).systemPrompt;
    };
    assert.ok(make(a).includes("PERSONA-A"));
    assert.ok(make(b).includes("PERSONA-B"));
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("AGENTS.md is never re-injected by this extension", async () => {
  const agentDir = tempDir();
  const cwd = tempDir();
  try {
    writeFileSync(join(cwd, "AGENTS.md"), "# conv\n- be terse", "utf-8");
    const id = await makePersona(agentDir, "X", "persona");
    const text = svc.buildPersonaInjection(id, agentDir);
    assert.equal(text.includes("be terse"), false);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("every-turn mode: before_agent_start returns a forced systemPrompt with persona", async () => {
  const agentDir = tempDir();
  try {
    const id = await makePersona(agentDir, "P", "PERSONA-X");
    const ext = svc.createPersonalityExtension(() => id, agentDir, () => "every-turn");
    let before;
    ext({ on: (e, fn) => { if (e === "before_agent_start") before = fn; } });
    const r = before({ systemPrompt: "BASE" });
    assert.ok(r && r.systemPrompt.includes("<personality>") && r.systemPrompt.includes("PERSONA-X"));
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("cached mode: before_agent_start sets sections and leaves systemPrompt alone", async () => {
  const agentDir = tempDir();
  try {
    const id = await makePersona(agentDir, "P", "PERSONA-Y");
    svc.saveGlobalRules("RULE-Z", agentDir);
    const ext = svc.createPersonalityExtension(() => id, agentDir, () => "cached");
    let before, ctxSys;
    ext({ on: (e, fn) => { if (e === "before_agent_start") before = fn; if (e === "context_with_system") ctxSys = fn; } });
    const event = { systemPrompt: "BASE", systemPromptOptions: {} };
    const r = before(event);
    assert.equal(r, undefined, "does not force a new systemPrompt");
    assert.equal(event.systemPromptOptions.sections.personality, "PERSONA-Y");
    assert.equal(event.systemPromptOptions.sections["generic-rules"], "RULE-Z");

    // context_with_system guard re-adds the sections if a compaction dropped them.
    const head = { role: "system", sections: {} };
    ctxSys({ messages: [head] });
    assert.equal(head.sections.personality, "PERSONA-Y");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("every-turn mode replaces a personality block another extension already mounted", async () => {
  const agentDir = tempDir();
  try {
    const id = await makePersona(agentDir, "P", "PERSONA-MINE");
    const ext = svc.createPersonalityExtension(() => id, agentDir, () => "every-turn");
    let before;
    ext({ on: (e, fn) => { if (e === "before_agent_start") before = fn; } });
    // A pi prompt extension mounts PERSONALITY.md and forces the prompt first.
    const base = "BASE\n\n<personality>\nPERSONALITY-MD-OLD\n</personality>\n\n<seep-reverse-lab>\nLAB\n</seep-reverse-lab>";
    const r = before({ systemPrompt: base, systemPromptOptions: { sections: { personality: "PERSONALITY-MD-OLD" } } });
    assert.equal((r.systemPrompt.match(/<personality>/g) ?? []).length, 1, "exactly one identity reaches the model");
    assert.ok(r.systemPrompt.includes("PERSONA-MINE"));
    assert.ok(!r.systemPrompt.includes("PERSONALITY-MD-OLD"));
    assert.ok(r.systemPrompt.includes("<seep-reverse-lab>"), "another extension's section survives");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("cached mode also forces the text when another extension made the prompt opaque", async () => {
  const agentDir = tempDir();
  try {
    const id = await makePersona(agentDir, "P", "PERSONA-CACHED");
    const ext = svc.createPersonalityExtension(() => id, agentDir, () => "cached");
    let before;
    ext({ on: (e, fn) => { if (e === "before_agent_start") before = fn; } });
    // Sections alone never reach the request once forceSystemPrompt is set.
    const opaque = { systemPrompt: "BASE\n\n<personality>\nPERSONALITY-MD-OLD\n</personality>", systemPromptOptions: { forceSystemPrompt: "BASE" } };
    const r = before(opaque);
    assert.ok(r && r.systemPrompt, "forces the request text too");
    assert.equal((r.systemPrompt.match(/<personality>/g) ?? []).length, 1);
    assert.ok(r.systemPrompt.includes("PERSONA-CACHED"));
    assert.equal(opaque.systemPromptOptions.sections.personality, "PERSONA-CACHED", "the transcript section is still ours");

    // A structured prompt keeps the cheap path: no forced text.
    const structured = { systemPrompt: "BASE", systemPromptOptions: {} };
    assert.equal(before(structured), undefined);
    assert.equal(structured.systemPromptOptions.sections.personality, "PERSONA-CACHED");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("no persona leaves another extension's PERSONALITY.md alone (rules still win)", async () => {
  const agentDir = tempDir();
  try {
    svc.saveGlobalRules("RULE-G", agentDir);
    const ext = svc.createPersonalityExtension(() => null, agentDir, () => "every-turn");
    let before;
    ext({ on: (e, fn) => { if (e === "before_agent_start") before = fn; } });
    const base = "BASE\n\n<personality>\nPERSONALITY-MD-OLD\n</personality>";
    const r = before({ systemPrompt: base, systemPromptOptions: {} });
    assert.ok(r.systemPrompt.includes("PERSONALITY-MD-OLD"));
    assert.ok(r.systemPrompt.includes("RULE-G"));
    assert.equal((r.systemPrompt.match(/<personality>/g) ?? []).length, 1);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
