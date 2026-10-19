import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface RewindResult {
  success: boolean;
  removedCount: number;
  reason?: string;
}

interface RawEntry {
  type?: string;
  id?: string;
  [key: string]: unknown;
}

/**
 * Read a session file into the entries this module reasons about.
 * A line that cannot be parsed is kept verbatim but can never be a target.
 */
function readEntries(sessionFilePath: string): { ok: true; entries: { text: string; parsed: RawEntry }[] } | { ok: false; reason: string } {
  if (!existsSync(sessionFilePath)) return { ok: false, reason: "session file missing" };
  let raw: string;
  try {
    raw = readFileSync(sessionFilePath, "utf-8");
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
  const entries: { text: string; parsed: RawEntry }[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: RawEntry;
    try {
      parsed = JSON.parse(line) as RawEntry;
    } catch {
      entries.push({ text: line, parsed: {} });
      continue;
    }
    entries.push({ text: line, parsed });
  }
  return { ok: true, entries };
}

function isAssistantReply(entry: RawEntry): boolean {
  if (entry.type !== "message") return false;
  const message = entry.message as { role?: unknown; content?: unknown } | undefined;
  if (message?.role !== "assistant") return false;
  // A reply that called tools is part of a work chain: deleting it would also drop
  // the tool results the user wants to keep, so "delete this reply" refuses it.
  const content = Array.isArray(message.content) ? message.content : [];
  return !content.some((block) => (block as { type?: string } | null)?.type === "toolCall");
}
export interface PurgeReplyCheck {
  ok: boolean;
  reason?: string;
  /** The question the reply answered, so the client can put it back in the composer. */
  draft?: string;
}

function textOfMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => (block as { type?: string } | null)?.type === "text")
    .map((block) => (block as { text?: string }).text ?? "")
    .join("\n")
    .trim();
}

/**
 * Whether `targetEntryId` can be removed on its own as "this reply": it must be an
 * assistant message without tool calls, and no later message may exist (so exactly
 * one reply disappears; the question and any earlier work stay).
 */
export function checkPurgeReplyTarget(sessionFilePath: string, targetEntryId: string): PurgeReplyCheck {
  const read = readEntries(sessionFilePath);
  if (!read.ok) return { ok: false, reason: read.reason };
  const targetIndex = read.entries.findIndex((entry) => entry.parsed.id === targetEntryId);
  if (targetIndex < 0) return { ok: false, reason: "target entry not found" };
  const target = read.entries[targetIndex].parsed;
  if (!isAssistantReply(target)) {
    return { ok: false, reason: "only an assistant reply without tool calls can be deleted on its own" };
  }
  const laterMessage = read.entries.slice(targetIndex + 1).some((entry) => entry.parsed.type === "message");
  if (laterMessage) {
    return { ok: false, reason: "only the last reply can be deleted on its own" };
  }
  // The nearest user message before it is the question to put back in the composer.
  let draft = "";
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    const entry = read.entries[index].parsed;
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: unknown; content?: unknown } | undefined;
    if (message?.role !== "user") continue;
    draft = textOfMessageContent(message.content);
    break;
  }
  return { ok: true, ...(draft ? { draft } : {}) };
}

/**
 * Physically truncate a pi session JSONL file so that `targetEntryId` and every
 * entry after it are removed, leaving the session as it was just before that
 * entry was appended. The `{"type":"session"}` header is always preserved.
 *
 * This is pure file surgery (no SessionManager), so it cannot be confused by
 * an in-memory index. It refuses if the target is the header or is not found,
 * and if the resulting file would have no header.
 */
export function rewindSessionInPlace(sessionFilePath: string, targetEntryId: string): RewindResult {
  const read = readEntries(sessionFilePath);
  if (!read.ok) {
    return { success: false, removedCount: 0, reason: read.reason };
  }
  const entries = read.entries;

  const headerIndex = entries.findIndex((e) => e.parsed.type === "session");
  if (headerIndex < 0) {
    return { success: false, removedCount: 0, reason: "session header not found" };
  }

  const targetIndex = entries.findIndex((e) => e.parsed.id === targetEntryId);
  if (targetIndex < 0) {
    return { success: false, removedCount: 0, reason: "target entry not found" };
  }
  if (targetIndex <= headerIndex) {
    return { success: false, removedCount: 0, reason: "cannot rewind the session header" };
  }

  // Keep everything strictly before the target; the header is before it by the
  // check above, so it always survives.
  const kept = entries.slice(0, targetIndex);
  const removedCount = entries.length - kept.length;

  // Appends guarantee a parent is written before its child, so cutting a suffix
  // cannot orphan anything — except a compaction entry that points forward into
  // the removed tail (`firstKeptEntryId`). Refuse rather than leave a session
  // whose transcript references an entry that no longer exists.
  const keptIds = new Set(kept.map((e) => e.parsed.id).filter((id): id is string => typeof id === "string"));
  for (const entry of kept) {
    const parentId = entry.parsed.parentId;
    if (typeof parentId === "string" && parentId && !keptIds.has(parentId)) {
      return { success: false, removedCount: 0, reason: `entry ${String(entry.parsed.id)} would lose its parent` };
    }
    const firstKept = entry.parsed.firstKeptEntryId;
    if (typeof firstKept === "string" && firstKept && !keptIds.has(firstKept)) {
      return { success: false, removedCount: 0, reason: `entry ${String(entry.parsed.id)} would lose a referenced entry` };
    }
  }

  const out = `${kept.map((e) => e.text).join("\n")}\n`;
  try {
    writeFileSync(sessionFilePath, out, "utf-8");
  } catch (err) {
    return { success: false, removedCount: 0, reason: String(err) };
  }

  return { success: true, removedCount };
}
