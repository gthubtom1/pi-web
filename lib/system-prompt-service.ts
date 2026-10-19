import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "./session-reader";
import { readPersonaText } from "./personas";
import { readPersonaInjectSettings, type PersonaInjectMode } from "./persona-inject-settings";

/**
 * Prompt injection for a conversation, assembled per turn:
 *   <personality>   — the persona the conversation picked (may be none)
 *   <generic-rules> — the single GLOBAL rules file, applied to every conversation
 *
 * AGENTS.md is NOT injected here: the SDK already loads it natively as
 * `<project_instructions>` (global + each project level), so re-injecting it would
 * duplicate it. Subagents do not use this extension.
 *
 * A pi install may also run a prompt extension of its own (for example one that
 * mounts `PERSONALITY.md` as the `personality` section), and its handler runs
 * before this one. When a conversation picked a persona, ours replaces that block
 * instead of joining it, so the model never receives two competing identities.
 */

export function getRulesPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "RULES.md");
}

export function getLegacyPersonalityPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "PERSONALITY.md");
}

export function getAgentsPath(cwd?: string, agentDir: string = getAgentDir()): string {
  return cwd ? join(cwd, "AGENTS.md") : join(agentDir, "AGENTS.md");
}

function readIfPresent(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    return "";
  }
}

/**
 * Write a prompt file only when its text actually changed. These files belong to
 * the project too (`<cwd>/AGENTS.md`), so an untouched tab must not rewrite — and
 * reformat — a file the user keeps in version control.
 */
function writeIfChanged(path: string, text: string): void {
  const next = text.trim();
  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf-8").trim() === next) return;
    } catch {
      // unreadable: fall through and write
    }
  }
  writeFileSync(path, next ? `${next}\n` : "", "utf-8");
}

/** The global rules text (single file, applied to every conversation). */
export function readGlobalRules(agentDir: string = getAgentDir()): string {
  return readIfPresent(getRulesPath(agentDir));
}

export function saveGlobalRules(text: string, agentDir: string = getAgentDir()): void {
  writeIfChanged(getRulesPath(agentDir), text);
}

/** The old single PERSONALITY.md, offered for one-click import into a persona. */
export function readLegacyPersonality(agentDir: string = getAgentDir()): string {
  return readIfPresent(getLegacyPersonalityPath(agentDir));
}

export function readAgentsFile(cwd?: string, agentDir: string = getAgentDir()): string {
  return readIfPresent(getAgentsPath(cwd, agentDir));
}

export function saveAgentsFile(text: string, cwd?: string, agentDir: string = getAgentDir()): void {
  writeIfChanged(getAgentsPath(cwd, agentDir), text);
}

/**
 * The text injected at the head of a run for a conversation using `personaId`:
 * the persona block (if any) followed by the global rules block (if any). Empty
 * when the conversation has no persona and there are no rules — the original,
 * unmodified prompt.
 */
/** The raw persona text and rules text, un-wrapped (used by the cached-sections mode). */
export function buildPersonaInjectionParts(personaId: string | null, agentDir: string = getAgentDir()): { personality: string; rules: string } {
  const personality = personaId ? readPersonaText(agentDir, personaId).trim() : "";
  const rules = readGlobalRules(agentDir).trim();
  return { personality, rules };
}

export function buildPersonaInjection(personaId: string | null, agentDir: string = getAgentDir()): string {
  const sections: string[] = [];
  const personality = personaId ? readPersonaText(agentDir, personaId) : "";
  if (personality.trim()) {
    sections.push(`<personality>\n${personality.trim()}\n</personality>`);
  }
  const rules = readGlobalRules(agentDir);
  if (rules.trim()) {
    sections.push(`<generic-rules>\n${rules.trim()}\n</generic-rules>`);
  }
  return sections.join("\n\n");
}

const PERSONALITY_BLOCK = /<personality>[\s\S]*?<\/personality>\s*/gi;

/** Remove a `<personality>` block another extension already mounted, so only one wins. */
export function stripPersonalityBlock(prompt: string): string {
  return prompt.replace(PERSONALITY_BLOCK, "").trim();
}

/**
 * Prepend the conversation's persona + global rules to the system prompt each
 * turn. `getPersonaId` is read per run from this session's own state, so two
 * conversations inject different personas without interfering. Returns nothing
 * (leaving the SDK prompt untouched) when there is nothing to inject.
 */
export function createPersonalityExtension(
  getPersonaId: () => string | null,
  agentDir: string = getAgentDir(),
  getMode: () => PersonaInjectMode = () => readPersonaInjectSettings(agentDir).mode,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    // every-turn: force the persona+rules into the system prompt each run.
    pi.on("before_agent_start", (event: { systemPrompt: string; systemPromptOptions?: { sections?: Record<string, string>; forceSystemPrompt?: string } }) => {
      try {
        if (getMode() === "cached") {
          // cached: add the persona/rules as structured prompt sections. They are
          // diffed against the transcript, so they persist and stay byte-identical
          // turn to turn (prompt cache keeps working). The context_with_system
          // guard below re-adds them if compaction ever drops them.
          const injection = buildPersonaInjectionParts(getPersonaId(), agentDir);
          if (!injection.personality && !injection.rules) return undefined;
          const options = event.systemPromptOptions ?? (event.systemPromptOptions = {});
          options.sections = options.sections ?? {};
          // A picked persona replaces whatever another extension mounted under the
          // same section name; with no persona the existing section is left alone.
          if (injection.personality) options.sections["personality"] = injection.personality;
          if (injection.rules) options.sections["generic-rules"] = injection.rules;
          // Sections only reach the model while the prompt is structured. Another
          // extension may already have forced an opaque prompt (a pi prompt
          // extension does exactly that, and its text carries no sections), which
          // would silently drop this conversation's persona: in that case force the
          // text as well. The forced text repeats every turn verbatim, so the
          // provider cache still sees an identical system prompt.
          if (options.forceSystemPrompt !== undefined) {
            const composite = buildPersonaInjection(getPersonaId(), agentDir);
            const base = injection.personality
              ? stripPersonalityBlock(event.systemPrompt || options.forceSystemPrompt)
              : (event.systemPrompt || options.forceSystemPrompt).trim();
            return { systemPrompt: base ? `${composite}\n\n${base}` : composite };
          }
          // Leave the base systemPrompt untouched; the sections carry the injection.
          return undefined;
        }

        // every-turn (default): prepend as a forced prompt each run.
        const parts = buildPersonaInjectionParts(getPersonaId(), agentDir);
        const composite = buildPersonaInjection(getPersonaId(), agentDir);
        if (!composite) return undefined;
        // Drop a `<personality>` block another extension mounted (a pi prompt
        // extension may mount PERSONALITY.md): the chosen persona replaces it, so
        // the model sees exactly one identity.
        const base = parts.personality
          ? stripPersonalityBlock(event.systemPrompt || "")
          : (event.systemPrompt || "").trim();
        return { systemPrompt: base ? `${composite}\n\n${base}` : composite };
      } catch {
        return undefined;
      }
    });

    // cached mode: keep the sections present even after context compaction.
    pi.on("context_with_system", (event: { messages: Array<{ role?: string; sections?: Record<string, string | null> }> }) => {
      try {
        if (getMode() !== "cached") return undefined;
        const head = event.messages[0];
        if (!head || head.role !== "system") return undefined;
        const injection = buildPersonaInjectionParts(getPersonaId(), agentDir);
        if (!injection.personality && !injection.rules) return undefined;
        head.sections = head.sections ?? {};
        if (injection.personality) head.sections["personality"] = injection.personality;
        if (injection.rules) head.sections["generic-rules"] = injection.rules;
        return undefined;
      } catch {
        return undefined;
      }
    });
  };
}
