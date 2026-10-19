// Display names for MCP tools. pi registers them as `mcp__<server>__<tool>`
// (a third-party MCP extension as `mcp_<server>_<tool>`),
// sanitized to `[A-Za-z0-9_-]` and given a hash suffix past 64 characters or
// when another tool already has the name, so the registered name cannot be
// split back into the server's names: `docs.v2` / `search.pages` and
// `docs_v2` / `search_pages` sanitize alike, and either part may hold `__`. pi's TUI labels them `server/tool` from the tool
// definition; the browser has those names only in a result's details
// (`{ server, tool }`). Without a result a call keeps its registered name,
// which is also the name codemode scripts call it by.

/** Larger results are shown as the server sent them. */
const PRETTY_JSON_MAX_CHARS = 200_000;

import { isMcpToolName } from "./mcp-command";

export interface McpToolLabel {
  server: string;
  tool: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The server and tool an MCP call's result names, or null when there is none to
 * go by. Both namings count (`mcp__server__tool`, or a third-party extension's
 * `mcp_server_tool`): the label comes from the result's details, never from
 * splitting the name, which cannot be split back unambiguously.
 */
export function mcpToolLabel(toolName: string, details?: unknown): McpToolLabel | null {
  if (!isMcpToolName(toolName) || !isRecord(details)) return null;
  const { server, tool } = details;
  return typeof server === "string" && typeof tool === "string" && server && tool ? { server, tool } : null;
}

/**
 * MCP servers often answer with one JSON document as text, compacted. Show it
 * indented; anything else, including JSON surrounded by other text, as sent.
 */
export function prettyMcpResultText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length > PRETTY_JSON_MAX_CHARS || !/^[[{]/.test(trimmed)) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}
