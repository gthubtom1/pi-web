# Personas, rules and prompt injection

A **persona** is a named prompt a single conversation can pick; **rules** apply to every
conversation. This replaces pi's single global `PERSONALITY.md` with a list, without touching the
`pi` CLI's files.

## Storage (`lib/personas.ts`)

- Text lives in one Markdown file per persona, `<agentDir>/personas/<id>.md`; `<agentDir>/personas.json`
  holds only `{ id, name, createdAt, updatedAt }` plus `defaultPersonaId`. A 30 KB persona card is
  never re-serialized to change its name, and the index stays small however many personas exist.
- Every index change goes through `mutateIndex()`: lock the index, **re-read it under the lock**,
  mutate, write a temp file, rename. Reading the index before the lock was a lost-update bug (two
  tabs saving at once, one entry silently gone).
- `savePersona()` never creates a second default: the first persona becomes the default only while
  `defaultPersonaId` is null. `setDefaultPersona(null)` is allowed (new conversations start empty);
  deleting the default falls back to the first remaining persona.
- `GET /api/personas?meta=1` returns metadata only (`personality: ""`, no legacy text): the composer
  loads the list with every session, and persona cards are tens of kilobytes.

## Which persona a conversation uses (`lib/session-persona.ts`, `lib/rpc-manager.ts`)

- The pick is an append-only custom entry, `customType: "pi-web:persona"`, data `{ version: 1, personaId }`
  (mirrors `lib/session-tool-selection.ts`). Newest entry wins; `personaId: null` means "no persona",
  which is *different* from having no entry (that follows the global default). `resolvePersonaId()`
  implements the three-way rule.
- A brand-new session takes the composer's pick via `POST /api/agent/new`'s `personaId` (`string | null`,
  **omitted** when the user never touched the picker). The route must strip it from the prompt command
  and pass it to `startRpcSession({ personaId })`, which appends the entry and uses it for the wrapper's
  persona ref. Sending it in the prompt command instead was the bug where a fresh composer's pick was
  ignored and the session silently used the default.
- `set_persona` updates the ref immediately; the injection extension reads the ref per run, so two
  conversations can use different personas at the same time. Subagents never use a persona
  (`disableAdvisor`-style: the profile drives their prompt).
- The hook keeps `personaId` as `string | null | undefined`: `undefined` = not resolved (a fresh
  composer, which displays the global default), `null` = explicitly none. Collapsing the two makes
  the selector lie or drops "no persona".

## Injection (`lib/system-prompt-service.ts`, `lib/persona-inject-settings.ts`)

- `before_agent_start` mounts `<personality>` (the persona) and `<generic-rules>` (the global
  `RULES.md`) for the conversation. `AGENTS.md` is not re-injected: the SDK loads it as
  `<project_instructions>` already.
- **`cached` mode** writes them as structured prompt `sections`; the SDK diffs sections against the
  transcript, so they persist and stay byte-identical (prompt cache keeps working), and a
  `context_with_system` guard re-adds them after a compaction.
- **`every-turn` mode** (default) returns a forced `systemPrompt` each run: robust, but the prompt is
  opaque for that run (sections stop being the thing the model sees).
- **A pi prompt extension can force the prompt too** (`~/.pi/agent/extensions/load-system-prompt.ts`
  mounts `PERSONALITY.md`, `RULES.md` and `SYSTEM.md` and returns `systemPrompt`). Its handler runs
  first (inline factories load last). Two consequences, both handled:
  1. every-turn strips an existing `<personality>` block from the base before prepending, so the
     model sees **one** identity, never the chosen persona plus `PERSONALITY.md`;
  2. when a forced prompt exists, `cached` mode has to force the text as well — sections alone never
     reach the request once the prompt is opaque. It keeps writing the section (so the transcript and
     compaction guard stay right) and returns the text too. The text is identical every turn, so the
     provider cache still hits.
- With no persona picked, another extension's `PERSONALITY.md` is left alone (the pi CLI keeps
  working); the chosen rules are still applied.
- `saveGlobalRules()` / `saveAgentsFile()` skip the write when the text is unchanged: the AGENTS.md tab
  points at `<cwd>/AGENTS.md`, a file the user keeps in version control.

## UI (`components/SystemPromptsConfig.tsx`, `components/PersonaSelector.tsx`)

- Settings › **Persona & Rules** (`prompts`): split view of personas plus the two global files, the
  injection-mode switch, "Import PERSONALITY.md", duplicate/delete/default.
- The sidebar puts the **fixed** entries first (Rules, AGENTS.md) and the **growing** list second:
  personas live in `.config-chip-box`, a bordered box that scrolls on its own (no visible scrollbar —
  `scrollbar-width: none` plus a hidden WebKit bar) with chips wrapping two per row. A dozen personas
  must not push the global rows off the panel, and a long name must not stretch a row.
- The composer's picker sits beside the model selector. A phone (≤640 px) has no room for its label,
  so it moves into the "More" popover; on a narrow desktop row the measured controls row falls back to
  an icon-only button (`controlsTight`, with hysteresis so it does not flicker). Before that, adding
  the button pushed the right-hand controls off the composer card at ~768 px.
- A new session's selector shows the **global default** until the user picks something — showing "no
  persona" there was wrong: the prompt would use the default.
