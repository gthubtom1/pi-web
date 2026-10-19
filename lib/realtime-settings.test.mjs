import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const settings = await jiti.import("./realtime-settings.ts");

function tempAgentDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-realtime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("defaults to auto when nothing was chosen", (t) => {
  const dir = tempAgentDir(t);
  assert.deepEqual(settings.readRealtimeSettings(dir), { version: 1, mode: "auto" });
});

test("each mode round-trips", (t) => {
  const dir = tempAgentDir(t);
  for (const mode of ["ws", "poll", "auto"]) {
    settings.writeRealtimeSettings(mode, dir);
    assert.equal(settings.readRealtimeSettings(dir).mode, mode);
  }
  assert.match(readFileSync(join(dir, "pi-web-realtime.json"), "utf8"), /"mode": "auto"/);
});

test("an unknown mode or a corrupt file reads as auto", (t) => {
  const dir = tempAgentDir(t);
  settings.writeRealtimeSettings("ws", dir);
  writeFileSync(join(dir, "pi-web-realtime.json"), JSON.stringify({ version: 1, mode: "carrier-pigeon" }), "utf8");
  assert.equal(settings.readRealtimeSettings(dir).mode, "auto");

  writeFileSync(join(dir, "pi-web-realtime.json"), "{ nope", "utf8");
  assert.equal(settings.readRealtimeSettings(dir).mode, "auto");
});
