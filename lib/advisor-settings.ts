import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./session-reader";

export type AdvisorMode = "off" | "manual" | "auto";
export type AdvisorInterruptOn = "none" | "concern" | "blocker";

export interface AdvisorSettings {
  /** off = 从不启用；manual = 仅手动触发；auto = 按任务复杂度自动决定。 */
  mode: AdvisorMode;
  /** 顾问模型（provider/modelId）。空 = 复用主对话模型。 */
  provider: string;
  modelId: string;
  /** 何种严重度会打断主对话（steer）。none = 只记录不打断。 */
  interruptOn: AdvisorInterruptOn;
  /** 自动模式下：本次任务工具调用达到该数量才启用顾问。 */
  autoMinToolCalls: number;
  /** 每次审查最多返回多少条意见。 */
  maxNotes: number;
}

const DEFAULTS: AdvisorSettings = {
  mode: "off",
  provider: "",
  modelId: "",
  interruptOn: "concern",
  autoMinToolCalls: 8,
  maxNotes: 4,
};

function advisorConfigPath(): string {
  const dir = getAgentDir();
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  return join(dir, "advisor.json");
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function asMode(value: unknown): AdvisorMode {
  return value === "manual" || value === "auto" || value === "off" ? value : "off";
}

function asInterruptOn(value: unknown): AdvisorInterruptOn {
  return value === "none" || value === "blocker" || value === "concern" ? value : "concern";
}

export function normalizeAdvisorSettings(input: unknown): AdvisorSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    mode: asMode(obj.mode),
    provider: typeof obj.provider === "string" ? obj.provider.trim() : "",
    modelId: typeof obj.modelId === "string" ? obj.modelId.trim() : "",
    interruptOn: asInterruptOn(obj.interruptOn),
    autoMinToolCalls: clampInt(obj.autoMinToolCalls, 1, 100, DEFAULTS.autoMinToolCalls),
    maxNotes: clampInt(obj.maxNotes, 1, 8, DEFAULTS.maxNotes),
  };
}

export function readAdvisorSettings(): AdvisorSettings {
  const path = advisorConfigPath();
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    return normalizeAdvisorSettings(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeAdvisorSettings(patch: unknown): AdvisorSettings {
  const next = normalizeAdvisorSettings({ ...readAdvisorSettings(), ...(patch as object) });
  writeFileSync(advisorConfigPath(), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return next;
}
