#!/usr/bin/env node
/**
 * 交付前一致性检查（只读）。回答一个问题：现在这份仓库自洽吗？
 *
 * 查六件事：
 *   1. Markdown 里的相对链接/路径是否都存在（清链接最容易留下的就是断链）
 *   2. AGENTS.md 的"文件地图"里列的文件是否都存在（它是维护契约）
 *   3. 代码里 t("key") 用到的键，en/zh-CN 是否都有；被删功能的键是否还在用
 *   4. 文档里的过期说法（已删功能/语言/版本）
 *   5. 发布产物（tag）与当前源码：有没有改到会被打进包里的文件
 *   6. 上游关系：可跟随的地址是否为零、`upstream` remote 是否还在
 *
 * 用法：node scripts/check-repo.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const notes = [];
const EOL = /\r?\n/;
/** A line that talks about something removed may name a path on purpose. */
const REMOVAL = /(删|移除|不再|removed|deleted|no longer|gone)/i;

function git(...args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".next") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(repoRoot);
const markdown = files.filter((file) => file.endsWith(".md"));
const code = files.filter((file) => /\.(ts|tsx|mjs)$/.test(file)
  && !file.endsWith(".test.mjs")
  && !relative(repoRoot, file).startsWith("demo" + sep)
  && !relative(repoRoot, file).startsWith("scripts" + sep));

// ---------------------------------------------------------------- 1. Markdown links and paths
for (const file of markdown) {
  const text = readFileSync(file, "utf8");
  const dir = dirname(file);

  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|#|\/)/.test(target)) continue;
    const withoutAnchor = target.split("#")[0];
    if (!withoutAnchor) continue;
    if (REMOVAL.test(contextOf(text, match.index))) continue;
    if (!existsSync(resolve(dir, withoutAnchor)) && !existsSync(resolve(repoRoot, withoutAnchor))) {
      problems.push(`断链 ${relative(repoRoot, file)} → ${target}`);
    }
  }

  for (const match of text.matchAll(/`((?:app|lib|bin|components|hooks|scripts|docs|public|demo)\/[A-Za-z0-9._@[\]/-]+\.(?:ts|tsx|mjs|js|cjs|md|json))`/g)) {
    const target = match[1];
    if (target.includes("<") || target.includes("*")) continue;
    if (/(example|例如|示例|e\.g\.|would be)/i.test(contextOf(text, match.index))) continue;
    if (REMOVAL.test(contextOf(text, match.index))) continue;
    const candidates = [resolve(repoRoot, target), resolve(dir, target)];
    if (!candidates.some((candidate) => existsSync(candidate))) {
      problems.push(`文档提到的文件不存在 ${relative(repoRoot, file)} → ${target}`);
    }
  }
}

/**
 * The whole line the match sits on, plus the one before it: a removal note may sit
 * above the path ("删掉的：`lib/x.ts`") or after it ("`lib/x.ts`（删除）").
 */
function contextOf(text, index) {
  const before = text.slice(0, index).split(EOL);
  const after = text.slice(index).split(EOL, 1)[0] ?? "";
  return `${before[before.length - 2] ?? ""} ${before[before.length - 1] ?? ""}${after}`;
}

// ---------------------------------------------------------------- 2. AGENTS.md file map
const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
const mapStart = agents.indexOf("## File Map");
const mapEnd = agents.indexOf("## Fork, base version");
const mapSection = mapStart >= 0 && mapEnd > mapStart ? agents.slice(mapStart, mapEnd) : "";
for (const line of mapSection.split(EOL)) {
  const match = /^ {2}([A-Za-z0-9._@[\]/-]+\.(?:ts|tsx|mjs|js|cjs|json))\s{2,}/.exec(line);
  if (!match) continue;
  const roots = ["", "lib", "components", "hooks", "bin", "app/api", "app"];
  if (!roots.some((root) => existsSync(join(repoRoot, root, match[1])))) {
    problems.push(`文件地图里的文件不存在：${match[1]}`);
  }
}

// ---------------------------------------------------------------- 3. i18n keys
const locales = ["en", "zh-CN"];
const messages = Object.fromEntries(locales.map((locale) => {
  const text = readFileSync(join(repoRoot, "lib", "i18n", "messages", `${locale}.ts`), "utf8");
  return [locale, new Set([...text.matchAll(/^\s{4}"([^"]+)":/gm)].map((m) => m[1]))];
}));
const used = new Map();
for (const file of code) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/\b(?:t|translate)\("([^"]+)"/g)) used.set(match[1], relative(repoRoot, file));
}
for (const [key, file] of used) {
  for (const locale of locales) {
    if (!messages[locale].has(key)) problems.push(`i18n 缺键（${locale}）：${key} ← ${file}`);
  }
}
const removedKeys = [
  "remote.modeLabel", "remote.modeQuick", "remote.modeNamed", "remote.namedTokenLabel",
  "remote.namedSave", "remote.namedClear", "remote.namedSaveConfirm", "remote.namedClearConfirm",
  "remote.namedSetupHint", "remote.switchToQuickHint",
];
for (const key of removedKeys) {
  if (used.has(key)) problems.push(`已删功能的文案仍在使用：${key} ← ${used.get(key)}`);
}

// ---------------------------------------------------------------- 4. stale claims in docs
for (const file of markdown) {
  const text = readFileSync(file, "utf8");
  if (/两扇门|two independent doors|Two doors for other devices/i.test(text)) {
    problems.push(`过期说法（门数）：${relative(repoRoot, file)}`);
  }
  if (/三语文案|three languages|`zh-TW`\s*-\s*Traditional/i.test(text)) {
    problems.push(`过期说法（语言数）：${relative(repoRoot, file)}`);
  }
}

// ---------------------------------------------------------------- 5. shipped files vs the release tag
const shipped = ["bin", "lib/ws-protocol.cjs", "public", "next.config.ts", "package.json", "fork.json"];
/** package.json fields that reach the artifact; a dev-only `scripts` entry does not. */
const ARTIFACT_FIELDS = ["name", "version", "description", "bin", "files", "engines", "dependencies", "peerDependencies", "optionalDependencies"];
const tag = git("describe", "--tags", "--abbrev=0");
if (tag) {
  const changed = git("diff", "--name-only", `${tag}..HEAD`, "--", ...shipped).split("\n").filter(Boolean);
  const needsRelease = changed.filter((file) => {
    if (file !== "package.json") return true;
    const before = git("show", `${tag}:package.json`);
    const after = git("show", "HEAD:package.json");
    try {
      const pick = (text) => JSON.stringify(Object.fromEntries(ARTIFACT_FIELDS.map((field) => [field, JSON.parse(text)[field]])));
      return pick(before) !== pick(after);
    } catch {
      return true;
    }
  });
  if (needsRelease.length === 0) notes.push(`发布产物 ${tag} 与当前源码一致（打进包的文件自该 tag 起未变）`);
  else for (const file of needsRelease) problems.push(`会打进包的文件在 ${tag} 之后改过，需要重新发布：${file}`);
} else {
  notes.push("没有 tag，跳过发布产物比对");
}

// ---------------------------------------------------------------- 6. upstream relationship
const followable = [];
for (const file of markdown.concat(code)) {
  const text = readFileSync(file, "utf8");
  const hit = /github\.com\/agegr|@agegr\/pi-web@/.test(text);
  const explained = /(opaque|历史|not a link|不是链接|Symbol\.for)/i.test(text);
  if (hit && !explained) followable.push(relative(repoRoot, file));
}
if (followable.length > 0) problems.push(`仍有可跟随的上游地址：${followable.join(", ")}`);
if (!/^upstream\s/m.test(git("remote", "-v"))) {
  notes.push("未配置 upstream remote（参考仓库）；要读它的提交时自行添加一个只读 remote");
}

// ---------------------------------------------------------------- report
console.log(`检查了 ${markdown.length} 个 Markdown、${code.length} 个源码文件`);
for (const note of notes) console.log(`  · ${note}`);
if (problems.length === 0) {
  console.log("\n✅ 没有发现问题");
  process.exit(0);
}
console.log(`\n❌ ${problems.length} 个问题：`);
for (const problem of problems) console.log(`  - ${problem}`);
process.exit(1);
