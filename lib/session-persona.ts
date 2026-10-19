import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "./types";
import { isValidPersonaId } from "./personas";

/**
 * Which persona a single conversation uses, persisted as an append-only custom
 * entry so it survives reloads and is independent per session. The newest entry
 * wins; `personaId: null` means "no persona" (rules only). A session with no
 * such entry follows the global default.
 *
 * This mirrors lib/session-tool-selection.ts.
 */
export const SESSION_PERSONA_TYPE = "pi-web:persona";

export interface SessionPersonaData {
  version: 1;
  personaId: string | null;
}

const CLEARED = Symbol("session-persona-none");

function parse(data: unknown): string | null | typeof CLEARED | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const record = data as { version?: unknown; personaId?: unknown };
  if (record.version !== 1) return undefined;
  if (record.personaId === null) return CLEARED;
  if (isValidPersonaId(record.personaId)) return record.personaId;
  return undefined;
}

/**
 * The session's own persona pick, if it has one. `undefined` means the session
 * has never chosen (so it follows the global default); `null` means it explicitly
 * chose "no persona".
 */
export function readSessionPersona(entries: readonly SessionEntry[]): string | null | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== SESSION_PERSONA_TYPE) continue;
    const parsed = parse(entry.data);
    if (parsed === undefined) continue;
    return parsed === CLEARED ? null : parsed;
  }
  return undefined;
}

export function appendSessionPersona(sessionManager: SessionManager, personaId: string | null): void {
  sessionManager.appendCustomEntry(SESSION_PERSONA_TYPE, {
    version: 1,
    personaId: personaId && isValidPersonaId(personaId) ? personaId : null,
  } satisfies SessionPersonaData);
}
