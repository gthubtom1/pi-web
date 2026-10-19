import { homedir } from "node:os";
import { join } from "node:path";

/**
 * pi's agent directory, resolved the way pi's `getAgentDir()` does:
 * `PI_CODING_AGENT_DIR` (with `~` expanded) when set, else `~/.pi/agent`.
 *
 * A tiny standalone copy so light modules (request security, the tunnel, the
 * secret store) do not pull in the whole SDK just to find a path.
 */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR;
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return join(homedir(), configured.slice(2));
  }
  return configured;
}
