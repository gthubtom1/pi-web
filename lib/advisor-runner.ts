import { randomUUID } from "node:crypto";
import type { Agent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  getSupportedThinkingLevels,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AdvisorSettings } from "./advisor-settings";

export type AdvisorSeverity = "blocker" | "concern" | "nit";

export interface AdvisorNote {
  severity: AdvisorSeverity;
  note: string;
}

const ADVISOR_TIMEOUT_MS = 120_000;
const ADVISOR_MAX_TOKENS = 1024;
const TRANSCRIPT_CHARS = 12_000;

const ADVISOR_SYSTEM_PROMPT = `You are an independent advisor reviewing another AI coding agent's work.
You see the conversation transcript. Your job is to catch mistakes the primary agent may be blind to:
wrong assumptions, dead-ends, missed requirements, risky or destructive actions, broken logic, or work that claims success without proof.
Do NOT repeat what the primary did well. Only surface concrete, actionable problems.

Respond ONLY with a JSON array (possibly empty) of objects shaped {"severity":"blocker|concern|nit","note":"..."}.
- blocker: the work is broken/unsafe and must be fixed before finishing.
- concern: likely a real problem worth fixing.
- nit: minor suggestion, safe to ignore.
If everything looks fine, return []. No prose, no markdown fences.`;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const type = (block as { type?: string }).type;
    if (type === "text" && typeof (block as { text?: unknown }).text === "string") {
      parts.push((block as { text: string }).text);
    } else if (type === "toolCall") {
      const name = (block as { name?: string }).name ?? "tool";
      parts.push(`[tool call: ${name}]`);
    }
  }
  return parts.join("\n").trim();
}

export function buildAdvisorTranscript(messages: AgentMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = textOf(message.content);
      if (text) lines.push(`User: ${text.slice(0, 2000)}`);
    } else if (message.role === "assistant") {
      const text = textOf(message.content);
      if (text) lines.push(`Assistant: ${text.slice(0, 2000)}`);
    } else if (message.role === "toolResult") {
      const name = (message as { toolName?: string }).toolName ?? "tool";
      const text = textOf(message.content);
      if (text) lines.push(`Result(${name}): ${text.slice(0, 500)}`);
    }
  }
  let joined = lines.join("\n\n");
  if (joined.length > TRANSCRIPT_CHARS) {
    // Keep the END: the advisor reviews the work just finished, and the tail is the
    // part a primary agent is most blind to.
    joined = `[...earlier turns truncated...]\n\n${joined.slice(-TRANSCRIPT_CHARS)}`;
  }
  return joined;
}

export function parseAdvisorNotes(raw: string, maxNotes: number): AdvisorNote[] {
  let value = raw.trim();
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) value = fenced[1].trim();
  const start = value.indexOf("[");
  const end = value.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const notes: AdvisorNote[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const note = typeof record.note === "string" ? record.note.trim() : "";
    if (!note) continue;
    const severity =
      record.severity === "blocker" || record.severity === "concern" || record.severity === "nit"
        ? (record.severity as AdvisorSeverity)
        : "concern";
    notes.push({ severity, note });
    if (notes.length >= maxNotes) break;
  }
  return notes;
}

function resolveAdvisorThinkingLevel(model: Model<Api>): ThinkingLevel {
  if (!model.reasoning) return "off";
  const supported = getSupportedThinkingLevels(model);
  const rejectsMinimal = model.api === "google-generative-ai" || /gemini/i.test(model.id);
  const usable = rejectsMinimal ? supported.filter((l) => l !== "off" && l !== "minimal") : supported;
  return usable[0] ?? supported[0] ?? "off";
}

function buildAdvisorRequest(model: Model<Api>, transcript: string): { context: Context; options: SimpleStreamOptions } {
  const thinkingLevel = resolveAdvisorThinkingLevel(model);
  return {
    context: {
      systemPrompt: ADVISOR_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: `Review this transcript:\n\n${transcript}` }],
          timestamp: Date.now(),
        },
      ],
    },
    options: {
      maxTokens: ADVISOR_MAX_TOKENS,
      cacheRetention: "none",
      sessionId: randomUUID(),
      ...(thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
    },
  };
}

/**
 * 运行一次顾问审查。使用与主会话相同的 provider 传输能力，但换用（可配置的）顾问模型。
 * 任何失败都安全降级为「无意见」，绝不抛出到主流程。
 */
export async function runAdvisorReview(
  session: AgentSession,
  settings: AdvisorSettings,
  signal?: AbortSignal,
): Promise<{ notes: AdvisorNote[]; usage?: { input: number; output: number } }> {
  try {
    const agent = (session as unknown as { agent: Agent }).agent;
    const primaryModel = agent.state.model as Model<Api> | undefined;
    let model: Model<Api> | undefined = primaryModel;
    if (settings.provider && settings.modelId) {
      const runtime = (session as unknown as { modelRuntime?: { getModel: (p: string, m: string) => Model<Api> | undefined } }).modelRuntime;
      const chosen = runtime?.getModel(settings.provider, settings.modelId);
      // 显式配置了顾问模型却解析不到时，宁可不审也不偷偷用主模型（避免误用昂贵模型）。
      model = chosen;
    }
    if (!model) return { notes: [] };

    const transcript = buildAdvisorTranscript([...agent.state.messages]);
    if (!transcript.trim()) return { notes: [] };

    const { context, options } = buildAdvisorRequest(model, transcript);
    const apiKey = await agent.getApiKey?.(model.provider);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), ADVISOR_TIMEOUT_MS);

    try {
      const stream = await agent.streamFunction(model, normalizeContext(context), {
        ...options,
        signal: controller.signal,
        ...(apiKey ? { apiKey } : {}),
      });
      const message = (await stream.result()) as AssistantMessage;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return { notes: [] };
      }
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => (block as { text: string }).text)
        .join("\n");
      const notes = parseAdvisorNotes(text, settings.maxNotes);
      const usage = message.usage
        ? { input: message.usage.input, output: message.usage.output }
        : undefined;
      return { notes, usage };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  } catch {
    return { notes: [] };
  }
}

export function shouldInterrupt(settings: AdvisorSettings, notes: AdvisorNote[]): boolean {
  if (settings.interruptOn === "none") return false;
  if (settings.interruptOn === "blocker") return notes.some((n) => n.severity === "blocker");
  // concern 档：concern 或 blocker 都打断
  return notes.some((n) => n.severity === "concern" || n.severity === "blocker");
}

export function formatAdvisorMessage(notes: AdvisorNote[]): string {
  const lines = notes.map((n) => `- [${n.severity}] ${n.note}`);
  return `顾问审查意见：\n${lines.join("\n")}`;
}
