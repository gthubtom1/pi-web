import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentDir } from "./agent-dir";
import {
  DEFAULT_REALTIME_MODE,
  isRealtimeMode,
  type RealtimeMode,
} from "./agent-event-transport";

/**
 * Settings › General › live connection: which transport the browser prefers.
 *
 * Kept in its own small file in the agent dir rather than in `settings.json`: pi
 * owns that file and writes it under a lock, and a browser transport choice has
 * nothing to do with the CLI's configuration. Absent or corrupt reads as `auto`,
 * which is the right default for every network except the one that made someone
 * open this switch.
 */

export const REALTIME_SETTINGS_FILE_NAME = "pi-web-realtime.json";

export interface RealtimeSettings {
  version: 1;
  mode: RealtimeMode;
}

export function readRealtimeSettings(agentDir: string = resolveAgentDir()): RealtimeSettings {
  const path = join(agentDir, REALTIME_SETTINGS_FILE_NAME);
  if (!existsSync(path)) return { version: 1, mode: DEFAULT_REALTIME_MODE };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { mode?: unknown };
    return { version: 1, mode: isRealtimeMode(parsed.mode) ? parsed.mode : DEFAULT_REALTIME_MODE };
  } catch {
    return { version: 1, mode: DEFAULT_REALTIME_MODE };
  }
}

export function writeRealtimeSettings(
  mode: RealtimeMode,
  agentDir: string = resolveAgentDir(),
): RealtimeSettings {
  mkdirSync(agentDir, { recursive: true });
  const path = join(agentDir, REALTIME_SETTINGS_FILE_NAME);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, mode }, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
  return { version: 1, mode };
}
