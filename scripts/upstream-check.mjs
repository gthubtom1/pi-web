#!/usr/bin/env node
/**
 * What an upstream update would cost us, before we take it.
 *
 * ONE upstream moves this project, and one other repository is only a reference:
 *
 *   pi       (@earendil-works/pi-*)   THE upstream. Pinned exactly (AGENTS.md); a new
 *                                      version can change the extension API, tool
 *                                      naming, session file format and the defaults
 *                                      we read. This is what we follow.
 *   pi-web   (`upstream` remote)       the project this one was forked from. Read its
 *                                      commits for how someone else adapted to the
 *                                      same pi; do NOT merge it as an authority and
 *                                      never install from it (docs/UPSTREAM-POLICY.md).
 *
 * This script answers, with local git state and `npm view` only:
 *
 *   - which pi packages we pin, and which published versions exist now;
 *   - which pi-web upstream commits have landed since our base;
 *   - which of *our* files those commits also touch (the conflict surface);
 *   - a test-failure fingerprint to compare against a fresh baseline worktree.
 *
 * It changes nothing. `--json` prints the same data for a script.
 *
 * Usage: node scripts/upstream-check.mjs [--json] [--no-network]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const offline = args.has("--no-network");

function git(...gitArgs) {
  try {
    return execFileSync("git", gitArgs, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/**
 * One shell command line, no args array: npm on Windows is `npm.cmd`, which only
 * runs through a shell, and passing an args array together with `shell: true`
 * triggers Node's DEP0190. The command lines here are ours, never user input.
 */
function sh(commandLine) {
  try {
    return execFileSync(commandLine, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: true,
      timeout: 60_000,
    }).trim();
  } catch {
    return "";
  }
}

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

// --- 1. what we pin, and what exists ---------------------------------------
const pinned = Object.entries(pkg.dependencies ?? {})
  .filter(([name]) => name.startsWith("@earendil-works/"))
  .map(([name, version]) => ({ name, version }));

const latest = [];
if (!offline) {
  // One query per package: `npm view <a>@latest <b>@latest version` answers with a
  // shape that differs by npm version, and this runs once per update check.
  for (const entry of pinned) {
    const version = sh(`npm view ${entry.name} version`);
    if (/^\d+\.\d+\.\d+/.test(version)) latest.push({ name: entry.name, latest: version });
  }
}

// --- 2. the pi-web upstream's new commits ----------------------------------
const upstreamRef = ["upstream/main", "upstream/master"].find((ref) => git("rev-parse", "--verify", "--quiet", ref)) ?? "";
/**
 * The upstream commit this fork branched from. Recorded once in
 * `.upstream-base.json` ({"commit": "…"}), overridable by an env var, and finally
 * guessed from the merge base with the upstream branch.
 */
function readUpstreamBase() {
  const file = join(repoRoot, ".upstream-base.json");
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (typeof parsed.commit === "string" && parsed.commit) return parsed.commit;
    }
  } catch {
    // A broken file is not a reason to fail; fall through to the other sources.
  }
  if (process.env.PI_WEB_UPSTREAM_BASE) return process.env.PI_WEB_UPSTREAM_BASE;
  const ref = ["upstream/main", "upstream/master"].find((candidate) => git("rev-parse", "--verify", "--quiet", candidate));
  return ref ? git("merge-base", "HEAD", ref) : "";
}

const mergeBase = readUpstreamBase();
const upstreamCommits = upstreamRef && mergeBase
  ? git("log", "--oneline", `${mergeBase}..${upstreamRef}`).split("\n").filter(Boolean)
  : upstreamRef
    ? git("log", "--oneline", "-20", upstreamRef).split("\n").filter(Boolean)
    : [];

// --- 3. the conflict surface: files both sides changed ---------------------
const ourFiles = new Set(
  (mergeBase ? git("diff", "--name-only", `${mergeBase}..HEAD`) : "")
    .split("\n")
    .filter(Boolean),
);
const theirFiles = new Set(
  (upstreamRef && mergeBase ? git("diff", "--name-only", `${mergeBase}..${upstreamRef}`) : "")
    .split("\n")
    .filter(Boolean),
);
const shared = [...ourFiles].filter((file) => theirFiles.has(file)).sort();

// --- 4. local state --------------------------------------------------------
const dirty = git("status", "--porcelain").split("\n").filter(Boolean).length;
const head = git("log", "--oneline", "-1");
const worktrees = git("worktree", "list", "--porcelain")
  .split("\n")
  .filter((line) => line.startsWith("worktree "))
  .map((line) => line.slice("worktree ".length));

const report = {
  head,
  dirty,
  worktrees,
  pinned,
  latest,
  upstream: {
    ref: upstreamRef || "(no upstream remote)",
    base: mergeBase || "(unknown: set .upstream-base.json or PI_WEB_UPSTREAM_BASE)",
    newCommits: upstreamCommits,
    sharedFiles: shared,
  },
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

const line = (text = "") => process.stdout.write(`${text}\n`);
line(`pi-web upstream check — ${report.head}`);
line(`working tree: ${dirty === 0 ? "clean" : `${dirty} changed path(s)`}   baseline worktrees: ${worktrees.length}`);
line();
line("PI SDK (pinned exactly; a new one is a whole-repo decision):");
for (const entry of pinned) {
  const hit = latest.find((item) => item.name === entry.name);
  const state = hit ? (hit.latest === entry.version ? "up to date" : `published ${hit.latest}`) : "unknown (offline)";
  line(`  ${entry.name.padEnd(40)} ${entry.version.padEnd(8)} ${state}`);
}
line();
if (!upstreamRef) {
  line("reference repository: no `upstream` remote is configured.");
  line("  Add the project this fork came from as a read-only remote named `upstream` (its commits are reference material).");
} else {
  line(`reference repository (${upstreamRef}), base ${report.upstream.base} — for reading, not merging:`);
  if (upstreamCommits.length === 0) {
    const tip = upstreamRef ? git("rev-parse", upstreamRef) : "";
    line(tip && tip === report.upstream.base
      ? "  nothing new (upstream tip is still our base; a stale fetch would look the same — run `git fetch upstream` first)"
      : "  nothing new since that base");
  } else {
    for (const commit of upstreamCommits.slice(0, 20)) line(`  ${commit}`);
    if (upstreamCommits.length > 20) line(`  … ${upstreamCommits.length - 20} more`);
  }
  line();
  line(`files both sides changed (${shared.length}) — read these when the reference takes a fix we want:`);
  if (shared.length === 0) line("  none");
  for (const file of shared.slice(0, 25)) line(`  ${file}`);
  if (shared.length > 25) line(`  … ${shared.length - 25} more`);
}
line();
line("next steps: docs/UPSTREAM-POLICY.md (pi is the upstream; four gates, then this):");
line("  git worktree add ../baseline HEAD   # before merging");
line("  npm test 2>&1 | tee /tmp/before.log # in the worktree");
line("  … merge, then rerun and compare the failing sets, not just the counts.");
