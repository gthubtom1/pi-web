/**
 * Banners the Seep workbench (`security-audit-interceptor.ts`) prepends to a user
 * prompt when it expands a shortcut or wraps a request in its compliance frame.
 *
 * The session file only ever holds the rewritten text, so a message recovered
 * after a Rewind still carries that banner. In the transcript it belongs there
 * (it marks "this prompt was rewritten"), but a draft that is about to be re-sent
 * is human-facing: leaving `[合规安全测试…]` at its head means the user has to
 * delete it by hand. These helpers strip it from a draft only.
 *
 * Keep this list byte-identical to `ENGINEERED_PREFIXES` in that extension.
 */
const ENGINEERED_PREFIXES: readonly string[] = [
  "[合规安全测试与授权白盒审计任务", // followed by ": 目标为沙盒环境…(CWE-602)]"
  "[授权白盒审计任务]",
  "[环境体检任务]",
  "[工作台极简看板请求]",
  "[外挂技能自动化脚手架任务]",
  "[实验工作环境已开启]",
];

/**
 * Remove a workbench banner from the head of `text`, leaving the body untouched.
 * Text that is not a workbench prompt (or has a malformed banner) is returned
 * as-is: never guess, never cut into the user's own words.
 */
export function stripEngineeredBanner(text: string): string {
  if (!text) return text;
  const head = text.replace(/^\s+/, "");
  const banner = ENGINEERED_PREFIXES.find((prefix) => head.startsWith(prefix));
  if (!banner) return text;
  // A banner contains no nested brackets, so the first "]" closes it. That covers
  // both `[任务: …(CWE-602)]\nbody` and `[任务] body`.
  const end = head.indexOf("]");
  if (end === -1) return text; // malformed banner: leave it alone
  return head.slice(end + 1).trimStart();
}
