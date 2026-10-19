// Who owns `/mcp`, decided the same way on the server and in the browser.
//
// The SDK loads pi's built-in MCP extension under the extension path
// `builtin:mcp`, and every command and tool it registers carries that path as
// its `sourceInfo.path`; `get_commands` hands the same field to the browser. A
// third-party extension that registers `/mcp` replaces the built-in one
// outright (the SDK drops a replaceable built-in that shares a command name),
// so the two never appear side by side. When several extensions register
// `/mcp`, pi names them `mcp:1`, `mcp:2`, … and none answers `/mcp` any more:
// pi looks a command up by that exact name, so a bare `/mcp` then runs no
// handler and reaches the model as text.
//
// The MCP host (`lib/mcp-host.ts`) stays inactive unless `/mcp` is the built-in
// one, the read-only policy (`lib/mcp-read-only-policy.ts`) recognises the
// built-in's tools by the path, and the composer opens Settings › MCP for a
// bare `/mcp` (ADR 0006). This module has no imports, so the browser can load it.

/** The `sourceInfo.path` of everything pi's built-in MCP extension registers. */
export const MCP_EXTENSION_PATH = "builtin:mcp";

export const MCP_COMMAND_NAME = "mcp";

/** The fields of a command entry (`pi.getCommands()`, `get_commands`) this module reads. */
export interface McpCommandCandidate {
  name: string;
  source?: string;
  sourceInfo?: { path?: string };
}

/** Whether a command is the built-in MCP extension's `/mcp`. */
export function isBuiltinMcpCommand(command: McpCommandCandidate): boolean {
  return command.name === MCP_COMMAND_NAME && command.sourceInfo?.path === MCP_EXTENSION_PATH;
}

/**
 * Whether an extension registered `/mcp`: the one command named `mcp`, or one
 * of several that pi renamed `mcp:<n>`. Any of them means the built-in MCP
 * extension was dropped, so the MCP host reports the first one's path as the
 * owner. Prompt templates are not extension commands, though `get_commands`
 * and `pi.getCommands()` list them too (`source: "prompt"`); skills are listed
 * as `skill:<name>` and never match.
 */
export function isMcpExtensionCommand(command: McpCommandCandidate): boolean {
  if (command.source === "prompt") return false;
  return command.name === MCP_COMMAND_NAME || /^mcp:\d+$/.test(command.name);
}

/**
 * What the MCP host does before a prompt sent while no run is going, given
 * the session's extension commands (`getRegisteredCommands()`, by invocation
 * name). pi runs an extension command at the very start of `prompt()` and
 * starts no run for it, so another extension's command needs no MCP server:
 * `"none"`. The built-in `/mcp` acts on the servers the host registered, which
 * it registers only before prompts, so `/mcp login docs` as a session's first
 * message needs them registered, but not connected: `"register"`. Anything
 * else may start a run: register, then wait for servers still connecting,
 * `"wait"`. The name is read as pi reads it: everything after the leading `/`
 * up to the first space. A prompt template or a skill (`/skill:name`) is no
 * extension command and starts a run.
 */
export function mcpPromptPreparation(message: string, commands: readonly McpCommandCandidate[]): "wait" | "register" | "none" {
  if (!message.startsWith("/")) return "wait";
  const space = message.indexOf(" ");
  const name = space === -1 ? message.slice(1) : message.slice(1, space);
  const command = commands.find((candidate) => candidate.name === name);
  if (!command) return "wait";
  return isBuiltinMcpCommand(command) ? "register" : "none";
}

/**
 * The `sourceInfo.path` of whatever owns `/mcp` right now: `builtin:mcp` when the
 * built-in extension runs, else the path of the extension that replaced it (a
 * third-party MCP extension), else null when nothing does.
 *
 * The host, the policies and the composer all need this rather than a hard-coded
 * `builtin:mcp`: pi's `replaceable` mechanism drops the built-in when another
 * extension registers `/mcp`, and that extension's tools carry ITS path.
 */
export function mcpProviderPath(commands: readonly McpCommandCandidate[]): string | null {
  const builtin = commands.find(isBuiltinMcpCommand);
  if (builtin) return MCP_EXTENSION_PATH;
  const owner = commands.find(isMcpExtensionCommand);
  return owner?.sourceInfo?.path ?? null;
}

/**
 * Whether a tool name belongs to an MCP provider.
 *
 * pi's built-in extension registers `mcp__<server>__<tool>`; a third-party MCP
 * extension registers `mcp_<server>_<tool>` (pi-mcp-extension's default
 * `toolPrefix: "mcp"`). Both are MCP tools, and a policy that only knew the
 * double underscore silently stopped recognising every MCP tool the moment such
 * an extension took `/mcp` over.
 */
export function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp__") || name.startsWith("mcp_");
}

/** The SDK's MCP resource tools: registered by the built-in provider, no server needed. */
export const MCP_RESOURCE_TOOL_NAMES: readonly string[] = [
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
];

/**
 * The name globs a tool allowlist needs to admit MCP tools at all: both namings
 * plus the resource tools. An allowlist is fixed when a session is created, so a
 * pattern is the only way to admit tools a server registers later.
 */
export const MCP_TOOL_PATTERNS: readonly string[] = ["mcp__*", "mcp_*", ...MCP_RESOURCE_TOOL_NAMES];

/** Whether a composer message is `/mcp` alone, with no subcommand. */
export function isBareMcpCommand(message: string): boolean {
  return message.trim() === `/${MCP_COMMAND_NAME}`;
}

/**
 * Whether a bare `/mcp` opens Settings › MCP instead of being sent, given the
 * session's command list: when its `/mcp` is the built-in one, or when nothing
 * answers to `/mcp` at all (MCP turned off, `-builtin:mcp`, a Chat-only
 * session, or several extensions' `mcp:1`, `mcp:2`, which pi never runs for a
 * bare `/mcp`). Another extension's `/mcp`, and a prompt template named `mcp`
 * (pi expands it when no extension command has the name), keep the message,
 * which is sent as before. Subcommands are never asked about: `/mcp login`,
 * `logout` and `reconnect` act on the session's own connections.
 */
export function bareMcpOpensSettings(commands: readonly McpCommandCandidate[]): boolean {
  if (commands.some(isBuiltinMcpCommand)) return true;
  return !commands.some((command) => command.name === MCP_COMMAND_NAME);
}
