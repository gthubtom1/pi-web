import { NextResponse } from "next/server";
import { getAgentDir } from "@/lib/session-reader";
import {
  deletePersona,
  duplicatePersona,
  listPersonas,
  personasDirExists,
  readPersonasIndex,
  renamePersona,
  savePersona,
  setDefaultPersona,
} from "@/lib/personas";
import { readLegacyPersonality } from "@/lib/system-prompt-service";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function refusal(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/**
 * GET /api/personas — the list, the default, and the legacy file.
 *
 * `?meta=1` leaves out every persona's text: the composer only needs id + name,
 * and a persona card is tens of kilobytes, so the picker must not download them
 * on every session it opens.
 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal(403, "Untrusted API request");
  try {
    const agentDir = getAgentDir();
    const index = readPersonasIndex(agentDir);
    const metaOnly = new URL(req.url).searchParams.get("meta") === "1";
    return NextResponse.json(
      {
        personas: metaOnly
          ? index.personas.map((meta) => ({ ...meta, personality: "" }))
          : listPersonas(agentDir),
        defaultPersonaId: index.defaultPersonaId,
        // The legacy file is only read by the settings panel's import button.
        legacyPersonality: metaOnly ? "" : readLegacyPersonality(agentDir),
        hasPersonas: personasDirExists(agentDir),
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500, headers: NO_STORE });
  }
}

/**
 * POST /api/personas  body { action, ... }
 *   save        { id?, name, personality }
 *   rename      { id, name }
 *   duplicate   { id }
 *   delete      { id }
 *   set-default { id | null }
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal(403, "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "Content-Type must be application/json");
  try {
    const body = (await req.json()) as { action?: unknown; [key: string]: unknown };
    const action = typeof body.action === "string" ? body.action : "";
    const agentDir = getAgentDir();

    switch (action) {
      case "save": {
        const meta = await savePersona(
          {
            ...(typeof body.id === "string" ? { id: body.id } : {}),
            name: typeof body.name === "string" ? body.name : undefined,
            personality: typeof body.personality === "string" ? body.personality : undefined,
          },
          agentDir,
        );
        return NextResponse.json({ ok: true, persona: meta }, { headers: NO_STORE });
      }
      case "rename": {
        if (typeof body.id !== "string" || typeof body.name !== "string") return refusal(400, "id and name are required");
        return NextResponse.json({ ok: true, persona: await renamePersona(body.id, body.name, agentDir) }, { headers: NO_STORE });
      }
      case "duplicate": {
        if (typeof body.id !== "string") return refusal(400, "id is required");
        return NextResponse.json({ ok: true, persona: await duplicatePersona(body.id, agentDir) }, { headers: NO_STORE });
      }
      case "delete": {
        if (typeof body.id !== "string") return refusal(400, "id is required");
        await deletePersona(body.id, agentDir);
        return NextResponse.json({ ok: true }, { headers: NO_STORE });
      }
      case "set-default": {
        const id = body.id === null ? null : typeof body.id === "string" ? body.id : undefined;
        if (id === undefined) return refusal(400, "id must be a string or null");
        await setDefaultPersona(id, agentDir);
        return NextResponse.json({ ok: true }, { headers: NO_STORE });
      }
      default:
        return refusal(400, "Unknown action");
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400, headers: NO_STORE });
  }
}
