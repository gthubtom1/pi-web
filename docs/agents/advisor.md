# Advisor and rewind

Two independent, opt-in helpers on top of a conversation. Neither changes upstream behaviour while it
is off.

## Advisor (`lib/advisor-settings.ts`, `lib/advisor-runner.ts`, `components/AdvisorConfig.tsx`)

- An independent reviewer model looks at the finished turn from another angle (wrong assumptions,
  dead ends, missed requirements, risky actions) and either records its notes as a card or steers the
  main conversation. Settings › **Advisor**; off by default.
- Settings live in `<agentDir>/advisor.json` (mode `off | manual | auto`, the model, the interrupt
  severity, the auto threshold in tool calls, `maxNotes`). `readAdvisorSettings()` never throws; a
  corrupt file reads as the defaults.
- `auto`: after a turn settles (`agent_settled`, not aborted), `maybeRunAdvisor()` runs when that
  turn's `tool_execution_start` count reached the threshold. `manual`: only `/advisor`. `mode: off`
  still allows an explicit `/advisor`, because that is the user asking for one now.
- The review is one bounded call (`streamFunction`, 120 s, 1024 output tokens, `cacheRetention: none`)
  with **no tools**, so it cannot act. A configured advisor model that does not resolve means no
  review at all rather than silently using the (possibly expensive) main model.
- The transcript handed to it is the **tail** (12 000 chars): the head is dropped first, because the
  work just finished is what the reviewer is for.
- Notes arrive as a custom message (`customType: "advisor"`), so they are part of the context the next
  turn sees; `components/MessageView.tsx` labels the card `advisor.cardTitle`. When the severity
  crosses `interruptOn` it is sent as a follow-up with `triggerTurn`, and
  `advisorSuppressNextSettle` stops that run from triggering another review (no recursion).
- Subagent wrappers pass `disableAdvisor`: a background subagent is not a conversation the user is
  driving.
- `POST /api/advisor-settings` is an ordinary API route: origin/host guard and JSON content type, like
  every other route.

## Rewind (`lib/session-rewind.ts`, `POST /api/sessions/[id]/rewind`, `components/MessageView.tsx`)

Two depths, one route (`body.mode`):

- **`"reply"` — "Delete this reply"**, on the assistant footer of the last message: removes exactly that
  one assistant reply. The question and every earlier tool result stay, so a turn that scouted for ten
  minutes and then refused keeps its evidence. Guards (`checkPurgeReplyTarget()`): the target must be an
  assistant message **without tool calls** and the last `message` entry in the file; otherwise the API
  answers 400 with a readable reason. The route returns the question text (`draft`) so the client refills
  the composer — one Enter re-asks it, which is how a refusal gets re-rolled. No confirmation: one reply
  is low stakes and this is meant to be repeated.
- **`"rewind"` (default)** — the user-message button: truncates from that message on (question, replies
  and that turn's tool results all go) and refills the draft. Destructive, unlike upstream's Edit
  (navigate + re-prompt, old branch kept) and Fork (copy the branch), so it asks first
  (`rewind.confirm`).

- Truncation is file surgery: it keeps the original text of every surviving line and refuses a missing
  header, an unknown entry, the header itself, and (since a suffix cut can only orphan a forward-pointing
  `firstKeptEntryId` of a compaction) any surviving entry whose `parentId`/`firstKeptEntryId` would
  disappear.
- The route first refuses while the session runs (409), then shuts an idle wrapper down so its in-memory
  leaf cannot re-append the removed entries, then truncates and invalidates the session-list and manager
  caches. The client reloads the context.
- A recovered draft loses the workbench banner the Seep interceptor prepends (`lib/engineered-prompt.ts`):
  the transcript keeps it, the composer does not.
