import { NextResponse } from "next/server";
import type { AppUpdateResponse } from "@/lib/api-types";

export const dynamic = "force-dynamic";

const CURRENT_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";

/**
 * GET /api/app-update — this fork has no update channel to poll.
 *
 * The upstream package on npm (`@agegr/pi-web`) is a different project: pointing
 * this at the registry would tell the user a newer "version" exists and invite them
 * to replace this build with someone else's. The fork updates from its own git
 * clone (`pi-web update` reads the clone recorded by the last deploy), so there is
 * nothing to fetch here.
 */
export async function GET() {
  return NextResponse.json({
    currentVersion: CURRENT_VERSION,
    latestVersion: CURRENT_VERSION,
    updateAvailable: false,
    releaseUrl: "",
  } satisfies AppUpdateResponse);
}
