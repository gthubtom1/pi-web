import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { resolveAgentDir } from "./agent-dir";

/**
 * Personas (人设): named "破甲词" blocks a conversation can pick from. Each
 * persona's TEXT lives in its own Markdown file under `personas/`, while a tiny
 * `personas.json` holds only the list metadata (id + display name) and the
 * default. This keeps the index small and constant no matter how many personas
 * exist, lets two edits touch two different files (no lock contention), and
 * makes a single persona cheap to read on each turn.
 *
 * Rules (规则) are deliberately NOT here: they are one global file
 * (`RULES.md`) applied to every conversation.
 */

export const PERSONAS_DIR_NAME = "personas";
export const PERSONAS_INDEX_NAME = "personas.json";

export interface PersonaMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersonasIndex {
  version: 1;
  defaultPersonaId: string | null;
  personas: PersonaMeta[];
}

export interface Persona extends PersonaMeta {
  personality: string;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function root(agentDir: string): string {
  return join(agentDir, PERSONAS_DIR_NAME);
}

function indexPath(agentDir: string): string {
  return join(agentDir, PERSONAS_INDEX_NAME);
}

function personaPath(agentDir: string, id: string): string {
  return join(root(agentDir), `${id}.md`);
}

export function isValidPersonaId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

function ensureDir(agentDir: string): void {
  const dir = root(agentDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** A URL/file-name-safe id that does not collide with any existing persona. */
function newId(existing: Set<string>): string {
  for (let i = 0; i < 1000; i += 1) {
    const id = `p_${Math.random().toString(36).slice(2, 10)}`;
    if (!existing.has(id)) return id;
  }
  return `p_${Date.now().toString(36)}`;
}

function emptyIndex(): PersonasIndex {
  return { version: 1, defaultPersonaId: null, personas: [] };
}

function normalizeIndex(input: unknown): PersonasIndex {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return emptyIndex();
  const record = input as Record<string, unknown>;
  const personas: PersonaMeta[] = [];
  const seen = new Set<string>();
  if (Array.isArray(record.personas)) {
    for (const entry of record.personas) {
      if (typeof entry !== "object" || entry === null) continue;
      const item = entry as Record<string, unknown>;
      if (!isValidPersonaId(item.id) || seen.has(item.id)) continue;
      seen.add(item.id);
      personas.push({
        id: item.id,
        name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : item.id,
        createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date(0).toISOString(),
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date(0).toISOString(),
      });
    }
  }
  const defaultPersonaId =
    typeof record.defaultPersonaId === "string" && seen.has(record.defaultPersonaId)
      ? record.defaultPersonaId
      : null;
  return { version: 1, defaultPersonaId, personas };
}

/** Read the index (never throws; a corrupt file reads as empty). */
export function readPersonasIndex(agentDir: string = resolveAgentDir()): PersonasIndex {
  const path = indexPath(agentDir);
  if (!existsSync(path)) return emptyIndex();
  try {
    return normalizeIndex(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return emptyIndex();
  }
}

/**
 * Read-modify-write the index inside one lock (temp file + rename), like
 * lib/session-ui-state.ts. The index is re-read under the lock, so two tabs
 * saving at once cannot drop each other's entry.
 */
async function mutateIndex<T>(agentDir: string, mutate: (index: PersonasIndex) => T | Promise<T>): Promise<T> {
  mkdirSync(agentDir, { recursive: true });
  const path = indexPath(agentDir);
  if (!existsSync(path)) writeFileSync(path, `${JSON.stringify(emptyIndex(), null, 2)}\n`, "utf-8");
  const release = await lockfile.lock(path, { realpath: false, retries: 10 });
  try {
    const index = readPersonasIndex(agentDir);
    const result = await mutate(index);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, "utf-8");
    renameSync(tmp, path);
    return result;
  } finally {
    await release();
  }
}

/** The text of one persona, or "" when it does not exist. */
export function readPersonaText(agentDir: string, id: string): string {
  if (!isValidPersonaId(id)) return "";
  const path = personaPath(agentDir, id);
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    return "";
  }
}

/** All personas with their text, in index order. */
export function listPersonas(agentDir: string = resolveAgentDir()): Persona[] {
  const index = readPersonasIndex(agentDir);
  return index.personas.map((meta) => ({ ...meta, personality: readPersonaText(agentDir, meta.id) }));
}

export interface SavePersonaInput {
  id?: string;
  name?: string;
  personality?: string;
}

/** Create a persona when `id` is absent, otherwise update it. Returns the meta. */
export async function savePersona(input: SavePersonaInput, agentDir: string = resolveAgentDir()): Promise<PersonaMeta> {
  ensureDir(agentDir);
  const now = new Date().toISOString();
  const name = (input.name ?? "").trim();
  if (input.id && !isValidPersonaId(input.id)) throw new Error("Invalid persona id");

  return mutateIndex(agentDir, (index) => {
    if (input.id) {
      const existing = index.personas.find((p) => p.id === input.id);
      if (!existing) throw new Error("Persona not found");
      if (typeof input.personality === "string") {
        writeFileSync(personaPath(agentDir, input.id), input.personality.trim() + "\n", "utf-8");
      }
      if (name) existing.name = name;
      existing.updatedAt = now;
      return { ...existing };
    }

    const id = newId(new Set(index.personas.map((p) => p.id)));
    const meta: PersonaMeta = { id, name: name || "Persona", createdAt: now, updatedAt: now };
    writeFileSync(personaPath(agentDir, id), (input.personality ?? "").trim() + "\n", "utf-8");
    index.personas.push(meta);
    if (!index.defaultPersonaId) index.defaultPersonaId = id;
    return { ...meta };
  });
}

/** Rename a persona without touching its text. */
export async function renamePersona(id: string, name: string, agentDir: string = resolveAgentDir()): Promise<PersonaMeta> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name is required");
  return mutateIndex(agentDir, (index) => {
    const meta = index.personas.find((p) => p.id === id);
    if (!meta) throw new Error("Persona not found");
    meta.name = trimmed;
    meta.updatedAt = new Date().toISOString();
    return { ...meta };
  });
}

/** Duplicate a persona (text + name) under a new id. */
export async function duplicatePersona(id: string, agentDir: string = resolveAgentDir()): Promise<PersonaMeta> {
  const index = readPersonasIndex(agentDir);
  const source = index.personas.find((p) => p.id === id);
  if (!source) throw new Error("Persona not found");
  const text = readPersonaText(agentDir, id);
  return savePersona({ name: `${source.name} copy`, personality: text }, agentDir);
}

/** Delete a persona. Its default slot falls back to the first remaining one. */
export async function deletePersona(id: string, agentDir: string = resolveAgentDir()): Promise<void> {
  const removed = await mutateIndex(agentDir, (index) => {
    const before = index.personas.length;
    index.personas = index.personas.filter((p) => p.id !== id);
    if (index.personas.length === before) return false;
    if (index.defaultPersonaId === id) index.defaultPersonaId = index.personas[0]?.id ?? null;
    return true;
  });
  if (!removed) return;
  try {
    rmSync(personaPath(agentDir, id), { force: true });
  } catch {
    // ignore
  }
}

/** Set the default persona; null means "new conversations start with no persona". */
export async function setDefaultPersona(id: string | null, agentDir: string = resolveAgentDir()): Promise<void> {
  await mutateIndex(agentDir, (index) => {
    if (id !== null && !index.personas.some((p) => p.id === id)) throw new Error("Persona not found");
    index.defaultPersonaId = id;
  });
}

/** Which persona a conversation resolves to: its own pick, else the default, else none. */
export function resolvePersonaId(agentDir: string, sessionPersonaId: string | null | undefined): string | null {
  if (sessionPersonaId !== undefined && sessionPersonaId !== null) {
    return readPersonaText(agentDir, sessionPersonaId) ? sessionPersonaId : null;
  }
  if (sessionPersonaId === null) return null; // explicit "no persona"
  const index = readPersonasIndex(agentDir);
  return index.defaultPersonaId && readPersonaText(agentDir, index.defaultPersonaId)
    ? index.defaultPersonaId
    : null;
}

/** True when the agent dir already has personas on disk (used to detect a fresh install). */
export function personasDirExists(agentDir: string = resolveAgentDir()): boolean {
  try {
    return readdirSync(root(agentDir)).length > 0;
  } catch {
    return false;
  }
}
