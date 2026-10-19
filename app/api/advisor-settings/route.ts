import { NextResponse } from "next/server";
import { readAdvisorSettings, writeAdvisorSettings } from "@/lib/advisor-settings";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function refusal(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal(403, "Untrusted API request");
  try {
    return NextResponse.json({ success: true, data: readAdvisorSettings() }, { headers: NO_STORE });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal(403, "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "Content-Type must be application/json");
  try {
    const body = await req.json();
    return NextResponse.json({ success: true, data: writeAdvisorSettings(body) }, { headers: NO_STORE });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500, headers: NO_STORE });
  }
}
