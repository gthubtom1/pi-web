#!/usr/bin/env node
/**
 * Build this fork and install it as the global `pi-web` command.
 *
 * Two machine-level facts this handles, both of which made `npm run build` fail
 * on the development machine:
 *   1. `next build --webpack` needs more than Node's default heap (~4 GB on a
 *      16 GB machine) — it died with "JavaScript heap out of memory".
 *   2. `next/font/google` fetches Noto Sans Mono at build time, and Google Fonts
 *      is unreachable from mainland China without the local proxy. Node 24's
 *      NODE_USE_ENV_PROXY makes the build's fetch honor HTTPS_PROXY, so this
 *      script finds the proxy the same way the tunnel does.
 *
 * It also records this clone in `<agentDir>/pi-web-source.json`, which is what
 * `pi-web update` compares against its remote: this fork has no npm package, so the
 * git clone is the only update channel there is.
 *
 * Usage: npm run deploy [-- --skip-install]
 */
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { connect } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const skipInstall = args.has("--skip-install");
const COMMON_PROXY_PORTS = [7897, 7890, 7891, 1080, 10809, 10808, 2080, 8889, 20171];

function proxyFromEnv(env = process.env) {
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || "";
  const value = raw.trim();
  if (!value) return null;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
}

function canConnect(host, port, timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let done = false;
    const finish = (ok) => { if (done) return; done = true; socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function detectProxy() {
  const fromEnv = proxyFromEnv();
  if (fromEnv) return fromEnv;
  const found = await Promise.all(COMMON_PROXY_PORTS.map((port) => canConnect("127.0.0.1", port).then((ok) => (ok ? port : null))));
  const port = found.find((value) => value !== null);
  return port ? `http://127.0.0.1:${port}` : null;
}

function run(command, commandArgs, extraEnv = {}) {
  const started = Date.now();
  const child = spawn(command, commandArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...extraEnv },
  });
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve({ code: code ?? 1, seconds: Math.round((Date.now() - started) / 1000) }));
  });
}

const proxy = await detectProxy();
const heap = process.env.PI_WEB_BUILD_HEAP_MB || "9216";
const buildEnv = {
  NODE_OPTIONS: `--max-old-space-size=${heap}`,
  ...(proxy ? { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy } : {}),
};

console.log(`[deploy] building with --max-old-space-size=${heap}${proxy ? `, proxy ${proxy}` : ", no proxy detected"}`);
if (!proxy) {
  console.log("[deploy] no proxy: `next/font` must reach fonts.googleapis.com, or the build fails on a blocked network.");
}
const build = await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], buildEnv);
if (build.code !== 0) {
  console.error(`[deploy] build failed (${build.seconds}s). Fix the errors above; nothing was installed.`);
  process.exit(build.code);
}
console.log(`[deploy] build ok in ${build.seconds}s`);

if (!existsSync(join(repoRoot, ".next", "BUILD_ID"))) {
  console.error("[deploy] .next/BUILD_ID is missing after the build; refusing to install a package that cannot start.");
  process.exit(1);
}

// Record the clone before installing: `pi-web update` reads this file to know which
// repository to fetch and compare, and to print the exact update command.
function resolveAgentDir(env = process.env) {
  const configured = env.PI_CODING_AGENT_DIR;
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return join(homedir(), configured.slice(2));
  }
  return configured;
}

const agentDir = resolveAgentDir();
try {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "pi-web-source.json"),
    `${JSON.stringify({ repo: repoRoot, recordedAt: new Date().toISOString() }, null, 2)}
`,
    { encoding: "utf-8", mode: 0o600 },
  );
  console.log(`[deploy] recorded source clone: ${repoRoot}`);
} catch (error) {
  console.warn(`[deploy] could not record the source clone (${error.message}); \`pi-web update\` will have nothing to compare.`);
}

if (skipInstall) {
  console.log("[deploy] --skip-install: left the global command alone");
  process.exit(0);
}

const install = await run(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "-g", ".", "--no-fund", "--no-audit"]);
if (install.code !== 0) {
  console.error(`[deploy] global install failed (${install.seconds}s). Try: npm install -g . --allow-scripts=pi-web-fork`);
  process.exit(install.code);
}
const version = spawnSync(process.platform === "win32" ? "pi-web.cmd" : "pi-web", ["version"], { encoding: "utf-8", shell: process.platform === "win32" });
console.log(`[deploy] installed ${String(version.stdout ?? "").trim() || "pi-web"}`);
console.log("[deploy] start it with:  pi-web        (prints the login password and LAN URLs)");
