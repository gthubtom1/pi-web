import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./session-reader";

/**
 * How the persona + rules are injected into a conversation's system prompt.
 *
 * - "every-turn" (default): force the persona/rules into the system prompt on
 *   every turn via `forceSystemPrompt`. Most robust; the system prompt can change
 *   between turns, which may reduce prompt-cache hits.
 *
 * - "cached": write the persona/rules once as structured prompt `sections`; they
 *   persist in the transcript and stay byte-identical turn to turn, so prompt
 *   caching keeps working (fewer tokens). A `context_with_system` guard re-adds
 *   them if compaction ever drops them.
 *
 * The two modes exist so the effect on the model can be compared directly.
 */
export type PersonaInjectMode = "every-turn" | "cached";

export interface PersonaInjectSettings {
  mode: PersonaInjectMode;
}

const DEFAULTS: PersonaInjectSettings = { mode: "every-turn" };

function settingsPath(agentDir: string = getAgentDir()): string {
  try {
    if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
  } catch {
    // ignore
  }
  return join(agentDir, "persona-inject.json");
}

function asMode(value: unknown): PersonaInjectMode {
  return value === "cached" ? "cached" : "every-turn";
}

export function normalizePersonaInjectSettings(input: unknown): PersonaInjectSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return { mode: asMode(obj.mode) };
}

export function readPersonaInjectSettings(agentDir: string = getAgentDir()): PersonaInjectSettings {
  const path = settingsPath(agentDir);
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    return normalizePersonaInjectSettings(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return { ...DEFAULTS };
  }
}

export function writePersonaInjectSettings(patch: unknown, agentDir: string = getAgentDir()): PersonaInjectSettings {
  const next = normalizePersonaInjectSettings({ ...readPersonaInjectSettings(agentDir), ...(patch as object) });
  writeFileSync(settingsPath(agentDir), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return next;
}
