import { realpathSync } from "node:fs";
import { getAdditionalAllowedRoots, normalizeSlashes } from "./allowed-roots";
import { resolveAgentDir } from "./agent-dir";
import { isExistingPathWithinRoots, isPathWithinRoots } from "./path-security";
import { listAllSessions } from "./session-reader";
import { toSlashPath } from "./paths";
export { allowFileRoot, normalizeSlashes } from "./allowed-roots";
export { isWindowsAbsolutePath } from "./paths";

// Short-TTL cache for the allowed-roots set. Without this, every file list/read
// request re-scans every pi session on disk just to check access. 5s is short
// enough that newly-created cwds appear promptly; stored on globalThis so it
// survives Next.js hot-reload.
declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
}

const ALLOWED_ROOTS_TTL_MS = 5_000;

export async function getAllowedFileRoots(): Promise<Set<string>> {
  const now = Date.now();
  const cached = globalThis.__piAllowedRootsCache;
  if (cached && cached.expiresAt > now) return cached.roots;

  const sessions = await listAllSessions();
  const roots = new Set<string>();
  for (const s of sessions) {
    if (s.cwd) roots.add(normalizeSlashes(s.cwd));
    // The project root (main repo shared by all worktrees) is browsable too —
    // the project dropdown lists it even when only worktrees have sessions.
    if (s.projectRoot) roots.add(normalizeSlashes(s.projectRoot));
  }

  for (const root of getAdditionalAllowedRoots()) roots.add(root);

  globalThis.__piAllowedRootsCache = { roots, expiresAt: now + ALLOWED_ROOTS_TTL_MS };
  return roots;
}

/**
 * Files under the agent directory that hold credentials, and are therefore never
 * served by the file API.
 *
 * The allowed roots are the sessions' cwds, so a session opened in the home
 * directory (a normal thing to do) puts the whole agent dir in reach - including the
 * pairing secrets, the cookie-signing key and pi's provider credentials, which the
 * rest of the UI takes care never to send to the browser. Without this list that
 * care is undone by one `?type=read`. (`pi-web-tunnel.json` stays on it although the
 * named-tunnel token it once held is gone: a file written by an older version still
 * has that token in it until the next write.)
 */
const AGENT_CREDENTIAL_FILE_NAMES: ReadonlySet<string> = new Set([
  "pi-web-tunnel.json",
  "pi-web-remote-pairing.json",
  "pi-web-auth.json",
  "pi-web-session-key",
  "auth.json",
]);

/** Whether `target` is one of the agent dir's credential files (lexical, no I/O). */
export function isCredentialFile(target: string, agentDir: string = resolveAgentDir()): boolean {
  const name = (toSlashPath(target).split("/").pop() ?? "").toLowerCase();
  if (!AGENT_CREDENTIAL_FILE_NAMES.has(name)) return false;
  // Same containment rule the roots use, so `...gent\..gentuth.json`
  // and a sibling directory of the same name cannot sneak through.
  return isPathWithinRoots(normalizeSlashes(target), new Set([normalizeSlashes(agentDir)]));
}

/** Authorize a path lexically, without touching the filesystem. */
export function isFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  if (isCredentialFile(target)) return false;
  return isPathWithinRoots(target, allowedRoots);
}

/** Authorize an existing path after resolving symbolic links. */
export function isExistingFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  if (isCredentialFile(target)) return false;
  // A link inside an allowed root can reach a credential file by another path.
  try {
    if (isCredentialFile(realpathSync.native(target))) return false;
  } catch {
    // A missing path is refused by the roots check below anyway.
  }
  return isExistingPathWithinRoots(target, allowedRoots);
}
