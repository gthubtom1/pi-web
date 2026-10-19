import { join } from "node:path";
import { NextResponse } from "next/server";
import { getAgentDir } from "@/lib/session-reader";
import { getAgentsPath, readAgentsFile, readGlobalRules, saveAgentsFile, saveGlobalRules } from "@/lib/system-prompt-service";
import { getAllowedFileRoots, isFilePathAllowed, normalizeSlashes } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// 全局规则（RULES.md，所有对话生效）与项目规范（AGENTS.md）的读写。AGENTS.md
// 落在用户传入的 cwd 上，必须像 /api/files 一样限制在已知会话/项目根目录内。
async function cwdAllowed(cwd: string): Promise<boolean> {
  const roots = await getAllowedFileRoots();
  return isFilePathAllowed(normalizeSlashes(cwd), roots);
}

function refusal(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal(403, "Untrusted API request");
  try {
    const url = new URL(req.url);
    const cwd = url.searchParams.get("cwd") || undefined;
    if (cwd && !(await cwdAllowed(cwd))) return refusal(403, "Directory is not allowed");
    const agentDir = getAgentDir();
    return NextResponse.json({
      success: true,
      data: {
        rules: readGlobalRules(agentDir),
        rulesPath: join(agentDir, "RULES.md"),
        agents: readAgentsFile(cwd, agentDir),
        agentsPath: getAgentsPath(cwd, agentDir),
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal(403, "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "Content-Type must be application/json");
  try {
    const body = (await req.json()) as { rules?: string; agents?: string; cwd?: string };
    if (body.cwd && !(await cwdAllowed(body.cwd))) return refusal(403, "Directory is not allowed");
    const agentDir = getAgentDir();
    if (typeof body.rules === "string") saveGlobalRules(body.rules, agentDir);
    if (typeof body.agents === "string") saveAgentsFile(body.agents, body.cwd, agentDir);
    return NextResponse.json({
      success: true,
      data: {
        rules: readGlobalRules(agentDir),
        rulesPath: join(agentDir, "RULES.md"),
        agents: readAgentsFile(body.cwd, agentDir),
        agentsPath: getAgentsPath(body.cwd, agentDir),
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
