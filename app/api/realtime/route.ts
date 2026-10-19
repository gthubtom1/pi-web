import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isRealtimeMode } from "@/lib/agent-event-transport";
import { readRealtimeSettings, writeRealtimeSettings } from "@/lib/realtime-settings";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** GET /api/realtime — which live transport the browser should prefer. */
export async function GET() {
  try {
    return NextResponse.json(readRealtimeSettings(), { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: NO_STORE },
    );
  }
}

/** PUT /api/realtime — { mode: "auto" | "ws" | "poll" } (Settings › General). */
export async function PUT(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: NO_STORE });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415, headers: NO_STORE });
  }
  const body = await request.json().catch(() => null) as { mode?: unknown } | null;
  if (!isRealtimeMode(body?.mode)) {
    return NextResponse.json({ error: "mode must be auto, ws or poll" }, { status: 400, headers: NO_STORE });
  }
  try {
    return NextResponse.json(writeRealtimeSettings(body.mode), { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: NO_STORE },
    );
  }
}
