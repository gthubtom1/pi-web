import { NextResponse } from "next/server";
import {
  invalidateSessionListCache,
  invalidateSessionManagerCache,
  resolveSessionPath,
} from "@/lib/session-reader";
import { checkPurgeReplyTarget, rewindSessionInPlace } from "@/lib/session-rewind";
import { getRpcSession } from "@/lib/rpc-manager";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function refusal(status: number, code: string, error: string) {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

// POST /api/sessions/[id]/rewind - body { entryId, mode? }.
// Physically truncates the session file so the given entry and everything after
// it disappear from the transcript (and from what the model sees next).
// `mode: "reply"` narrows it to one assistant reply: the target must be a reply
// without tool calls and the last message in the file, so the question and every
// earlier tool result survive. The same file-level work applies: an open wrapper
// is shut down first so its in-memory leaf cannot re-append the removed entries.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) return refusal(403, "request-denied", "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "request-denied", "Content-Type must be application/json");
  const { id } = await params;

  let entryId: string | undefined;
  let mode: "rewind" | "reply" = "rewind";
  try {
    const body = (await req.json()) as { entryId?: unknown; mode?: unknown };
    entryId = typeof body.entryId === "string" ? body.entryId.trim() : undefined;
    if (body.mode === "reply") mode = "reply";
    else if (body.mode !== undefined && body.mode !== "rewind") {
      return refusal(400, "bad_request", "mode must be \"rewind\" or \"reply\"");
    }
  } catch {
    return refusal(400, "bad_request", "Invalid JSON body");
  }
  if (!entryId) return refusal(400, "bad_request", "entryId is required");

  try {
    const opened = getRpcSession(id);
    const sessionFilePath = (opened?.isAlive() ? opened.sessionFile : "") || await resolveSessionPath(id);
    if (!sessionFilePath) {
      invalidateSessionListCache();
      return refusal(404, "not_found", "Session not found");
    }

    // A running session cannot be rewound: its run still holds the transcript.
    if (opened?.isAlive() && opened.isRunning()) {
      return refusal(409, "session_running", "Stop the current run before rewinding.");
    }
    // Check the target before touching the file (and before shutting anything down).
    let draft: string | undefined;
    if (mode === "reply") {
      const check = checkPurgeReplyTarget(sessionFilePath, entryId);
      if (!check.ok) return refusal(400, "rewind_refused", check.reason ?? "This reply cannot be deleted on its own");
      draft = check.draft;
    }
    // Shut the idle wrapper down so its in-memory leaf does not resurrect entries.
    if (opened?.isAlive()) {
      try {
        await opened.shutdown();
      } catch {
        // best-effort: the file truncation below is what matters
      }
    }

    const result = rewindSessionInPlace(sessionFilePath, entryId);
    if (!result.success) {
      return refusal(400, "rewind_failed", "Could not rewind: entry not found or file unreadable");
    }

    invalidateSessionManagerCache(sessionFilePath);
    invalidateSessionListCache();

    return NextResponse.json(
      {
        success: true,
        sessionId: id,
        rewoundEntryId: entryId,
        removedEntries: result.removedCount,
        ...(draft !== undefined ? { draft } : {}),
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return refusal(500, "rewind_error", error instanceof Error ? error.message : String(error));
  }
}
