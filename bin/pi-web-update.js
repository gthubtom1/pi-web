"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { execFileSync } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");

/**
 * `pi-web update` for this fork.
 *
 * This project is not published to npm: `@agegr/pi-web` on the registry is the
 * upstream project, and following it would replace this fork with someone else's
 * build. So there is no registry call here at all. The source of truth is the git
 * repository this machine was installed from:
 *
 *   - `npm run deploy` records that clone in `<agentDir>/pi-web-source.json`
 *     (`bin/pi-web-run-*.json` style: one small file, overwritten each deploy);
 *   - `pi-web update` reads it, fetches, and reports how far behind it is, with the
 *     exact command to run;
 *   - `pi-web update --check` does the same without fetching.
 *
 * Nothing is installed or replaced from here: a git pull plus `npm run deploy` in
 * the clone is the whole update, and the user runs it (a build takes minutes and
 * must not start under a running server).
 */

const SOURCE_FILE_NAME = "pi-web-source.json";
const GIT_TIMEOUT_MS = 60_000;
const COMMIT_LINES = 12;

function parseStableVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function isNewerStableVersion(candidate, current) {
  const candidateParts = parseStableVersion(candidate);
  const currentParts = parseStableVersion(current);
  if (!candidateParts || !currentParts) return false;
  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] !== currentParts[index]) {
      return candidateParts[index] > currentParts[index];
    }
  }
  return false;
}

function agentDir() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured) {
    if (configured === "~") return os.homedir();
    if (configured.startsWith("~/") || configured.startsWith("~\\")) {
      return path.join(os.homedir(), configured.slice(2));
    }
    return configured;
  }
  return path.join(os.homedir(), ".pi", "agent");
}

function sourceFilePath() {
  return path.join(agentDir(), SOURCE_FILE_NAME);
}

/** The clone this machine was installed from, as recorded by the last deploy. */
function readSource(filePath = sourceFilePath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const repo = typeof parsed.repo === "string" ? parsed.repo : "";
    return repo && fs.existsSync(repo) ? { repo, recordedAt: parsed.recordedAt ?? null } : null;
  } catch {
    return null;
  }
}

function git(repo, args, run = execFileSync) {
  try {
    return String(run("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    })).trim();
  } catch {
    return "";
  }
}

/** How the recorded clone stands against its own remote. */
function readGitState(repo, { check, gitRun = git, fileExists = fs.existsSync } = {}) {
  if (!repo || !fileExists(path.join(repo, ".git"))) return { kind: "no-git", repo: repo ?? null };
  const branch = gitRun(repo, ["rev-parse", "--abbrev-ref", "HEAD"]) || "main";
  const remote = gitRun(repo, ["remote", "get-url", "origin"]);
  if (check) {
    return { kind: "check", repo, branch, remote, behind: null, ahead: null, commits: [] };
  }
  const fetched = gitRun(repo, ["fetch", "--quiet", "origin"]);
  if (fetched === "" && gitRun(repo, ["rev-parse", "--verify", "--quiet", `origin/${branch}`]) === "") {
    return { kind: "no-remote", repo, branch, remote };
  }
  const counts = gitRun(repo, ["rev-list", "--left-right", "--count", `HEAD...origin/${branch}`]);
  const [ahead, behind] = counts.split(/\s+/).map((value) => Number(value) || 0);
  const commits = behind > 0
    ? gitRun(repo, ["log", "--oneline", "--no-decorate", `HEAD..origin/${branch}`]).split("\n").filter(Boolean)
    : [];
  return { kind: "git", repo, branch, remote, ahead, behind, commits };
}

function runUpdate({
  check,
  currentVersion,
  readSourceFile = readSource,
  readState = readGitState,
  log = console.log,
  error = console.error,
}) {
  const source = readSourceFile();
  if (!source) {
    log(`pi-web fork ${currentVersion}: this build was not installed from a git clone, so there is nothing to check.`);
    log("Install it from its repository (docs/INSTALL.md):");
    log("  git clone <repository> && cd pi-web && npm install && npm run deploy");
    log("Then `pi-web update` can compare your clone with its remote.");
    return 0;
  }

  const state = readState(source.repo, { check });
  if (state.kind === "no-git") {
    error(`The recorded source ${source.repo} is not a git checkout any more. Reinstall from its repository.`);
    return 1;
  }
  const updateCommand = `git -C "${state.repo}" pull --ff-only && npm -C "${state.repo}" run deploy`;

  if (state.kind === "check") {
    log(`Source: ${state.repo} (branch ${state.branch}${state.remote ? `, origin ${state.remote}` : ""})`);
    log("Run `pi-web update` to compare it with its remote.");
    return 0;
  }
  if (state.kind === "no-remote") {
    error(`Could not read origin/${state.branch} in ${state.repo}. Run \`git -C "${state.repo}" fetch\` once, then retry.`);
    return 1;
  }

  log(`Source: ${state.repo} (branch ${state.branch}${state.remote ? `, origin ${state.remote}` : ""})`);
  if (state.behind === 0) {
    log(state.ahead > 0
      ? `Up to date with origin/${state.branch}; your clone has ${state.ahead} local commit(s) on top.`
      : `Up to date with origin/${state.branch}.`);
    return 0;
  }

  log(`${state.behind} new commit(s) on origin/${state.branch}:`);
  for (const commit of state.commits.slice(0, COMMIT_LINES)) log(`  ${commit}`);
  if (state.commits.length > COMMIT_LINES) log(`  … ${state.commits.length - COMMIT_LINES} more`);
  if (check) {
    log(`Run: ${updateCommand}`);
    return 0;
  }
  log("");
  log("This build is installed globally, so the update runs in the clone above:");
  log(`  ${updateCommand}`);
  log("(`pi-web stop` first if a server is running: the build replaces .next.)");
  return 0;
}

module.exports = {
  SOURCE_FILE_NAME,
  isNewerStableVersion,
  readGitState,
  readSource,
  runUpdate,
  sourceFilePath,
};
