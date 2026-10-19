import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isMcpTool, isReadOnlySelection } = await jiti.import("./mcp-read-only-policy.ts");

test("a pinned selection is read-only when it names tools and none can write or run commands", () => {
  assert.equal(isReadOnlySelection(["read", "grep", "find", "ls"]), true);
  assert.equal(isReadOnlySelection(["read"]), true);
  // No pin follows pi's configured tools, and an empty pin is Chat only, which loads no MCP.
  assert.equal(isReadOnlySelection(undefined), false);
  assert.equal(isReadOnlySelection([]), false);
  for (const writer of ["bash", "powershell", "edit", "write"]) {
    assert.equal(isReadOnlySelection(["read", writer]), false, writer);
  }
});

test("MCP tools are the built-in extension's and any named mcp__", () => {
  const source = (path) => ({ path, source: "builtin", scope: "user", origin: "top-level" });
  assert.equal(isMcpTool({ name: "read_mcp_resource", sourceInfo: source("builtin:mcp") }), true);
  assert.equal(isMcpTool({ name: "mcp__docs__search", sourceInfo: source("/ext/other-mcp.ts") }), true);
  assert.equal(isMcpTool({ name: "web_search", sourceInfo: source("/ext/search.ts") }), false);
  assert.equal(isMcpTool({ name: "codemode", sourceInfo: source("builtin:codemode") }), false);
});

test("a third-party MCP extension's tools are policed too (mcp_ naming, its own path)", () => {
  // Measured in this environment: pi-mcp-extension registers mcp_status /
  // mcp_connect from ~/.pi/agent/npm/node_modules/pi-mcp-extension, and pi 1.3.0
  // drops builtin:mcp because it is `replaceable`. Before this, isMcpTool() said
  // "no" to both, so the read-only policy silently stopped blocking MCP tools.
  const thirdParty = {
    path: "C:/Users/toti/.pi/agent/npm/node_modules/pi-mcp-extension/src/index.ts",
    source: "npm:pi-mcp-extension",
    scope: "user",
    origin: "package",
  };
  const tool = { name: "mcp_connect", sourceInfo: thirdParty };

  // Recognised by name alone, whatever registered it.
  assert.equal(isMcpTool(tool), true);
  assert.equal(isMcpTool({ name: "mcp_status", sourceInfo: undefined }), true);
  // And by the provider's path when the name were something else entirely.
  assert.equal(isMcpTool({ name: "custom_bridge", sourceInfo: thirdParty }, thirdParty.path), true);
  // A non-MCP extension tool stays out, with or without a provider path.
  assert.equal(isMcpTool({ name: "seep_tool_research", sourceInfo: { path: "/ext/seep.ts" } }, thirdParty.path), false);
});
