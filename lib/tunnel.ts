import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { resolveAgentDir } from "./agent-dir";
import { resolveOutboundProxy } from "./local-proxy";
import { addDynamicHost, removeDynamicHost } from "./dynamic-hosts";

/**
 * The public tunnel: a single `cloudflared` quick tunnel that exposes this
 * server at a random `https://<name>.trycloudflare.com` address, so a phone on
 * another network (no public IP, CGNAT) can reach it. Outbound-only, free, no
 * account.
 *
 * Lifecycle is a singleton on globalThis: start/stop from Settings, and the
 * exact hostname is registered with request-security only while it is up.
 */

export type TunnelStatus = "stopped" | "starting" | "running" | "error";
/** What a "starting" tunnel is busy with, so the panel can say something useful. */
export type TunnelPhase = "idle" | "downloading" | "connecting";

export interface TunnelState {
  status: TunnelStatus;
  url: string | null;
  hostname: string | null;
  error: string | null;
  startedAt: number | null;
  phase: TunnelPhase;
  /** True when cloudflared was found on PATH (vs. downloaded to the agent dir). */
  usingSystemBinary: boolean;
  /** Whether the downloaded binary is on disk (the panel shows Install/Uninstall from it). */
  binaryInstalled: boolean;
}

interface TunnelRuntime {
  child: ChildProcess | null;
  state: TunnelState;
  starting: Promise<TunnelState> | null;
}

declare global {
  var __piWebTunnel: TunnelRuntime | undefined;
}

const TRYCLOUDFLARE_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const START_TIMEOUT_MS = 45_000;

function runtime(): TunnelRuntime {
  if (!globalThis.__piWebTunnel) {
    globalThis.__piWebTunnel = {
      child: null,
      state: { status: "stopped", url: null, hostname: null, error: null, startedAt: null, usingSystemBinary: false, binaryInstalled: false, phase: "idle" },
      starting: null,
    };
  }
  return globalThis.__piWebTunnel;
}

export function getTunnelState(): TunnelState {
  return { ...runtime().state, binaryInstalled: existsSync(storedBinaryPath()) };
}

function binaryName(): string {
  return process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

function binDir(): string {
  return join(resolveAgentDir(), "pi-web-bin");
}

function storedBinaryPath(): string {
  return join(binDir(), binaryName());
}

/** Where a PATH lookup would find cloudflared, or null. */
function findOnPath(): string | null {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const result = spawnSync(cmd, ["cloudflared"], { encoding: "utf-8" });
    if (result.status === 0) {
      const first = result.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (first && existsSync(first)) return first;
    }
  } catch {
    // ignore
  }
  return null;
}

function downloadUrl(): string {
  if (process.env.PI_WEB_CLOUDFLARED_URL) return process.env.PI_WEB_CLOUDFLARED_URL;
  const base = "https://github.com/cloudflare/cloudflared/releases/latest/download";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  if (process.platform === "win32") return `${base}/cloudflared-windows-amd64.exe`;
  if (process.platform === "darwin") return `${base}/cloudflared-darwin-${arch}.tgz`;
  return `${base}/cloudflared-linux-${arch}`;
}

async function downloadBinary(): Promise<string> {
  if (downloadInFlight) return downloadInFlight;
  downloadInFlight = downloadBinaryOnce().finally(() => { downloadInFlight = null; });
  return downloadInFlight;
}

async function downloadBinaryOnce(): Promise<string> {
  const target = storedBinaryPath();
  if (existsSync(target)) return target;
  mkdirSync(binDir(), { recursive: true });

  const url = downloadUrl();
  const isTgz = url.endsWith(".tgz");
  // Never write to `target` while the transfer is in flight: an aborted or failing
  // download used to leave a truncated executable that every later start reused
  // (spawn then failed with ENOEXEC). The partial file is renamed into place only
  // once it is complete.
  const partial = `${target}.partial-${process.pid}`;
  const downloadPath = partial;

  try {
    // Use the machine's proxy (env vars, else a detected local 梯子) so the
    // download works on a China machine with no direct access to GitHub.
    const proxy = await resolveOutboundProxy();
    const response = await undiciFetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(600_000),
      ...(proxy ? { dispatcher: new ProxyAgent(proxy) } : {}),
    });
    if (!response.ok || !response.body) {
      throw new Error(`cloudflared download failed: HTTP ${response.status}. Install cloudflared manually or set PI_WEB_CLOUDFLARED_URL.`);
    }
    await new Promise<void>((resolve, reject) => {
      const file = createWriteStream(downloadPath);
      file.on("error", reject);
      // @ts-expect-error ReadableStream -> Node stream bridging works at runtime
      response.body.pipeTo(new WritableStream({
        write(chunk) { file.write(Buffer.from(chunk)); },
        close() { file.end(() => resolve()); },
        abort(reason) { file.destroy(); reject(reason instanceof Error ? reason : new Error(String(reason))); },
      })).catch(reject);
    });

    if (isTgz) {
      const result = spawnSync("tar", ["-xzf", downloadPath, "-C", binDir()], { encoding: "utf-8" });
      if (result.status !== 0) {
        throw new Error("cloudflared archive could not be extracted (tar missing?). Install cloudflared manually.");
      }
    } else {
      renameSync(downloadPath, target);
    }
    if (!existsSync(target)) throw new Error("cloudflared binary was not produced by the download.");
    try {
      chmodSync(target, 0o755);
    } catch {
      // Windows: no chmod needed
    }
    return target;
  } finally {
    // Complete or not, no partial download may stay behind.
    try {
      if (existsSync(partial)) rmSync(partial, { force: true });
    } catch {
      // ignore
    }
  }
}

async function ensureCloudflared(): Promise<{ path: string; system: boolean }> {
  if (process.env.PI_WEB_CLOUDFLARED && existsSync(process.env.PI_WEB_CLOUDFLARED)) {
    return { path: process.env.PI_WEB_CLOUDFLARED, system: true };
  }
  const onPath = findOnPath();
  if (onPath) return { path: onPath, system: true };
  return { path: await downloadBinary(), system: false };
}

// Single-flight the download so two start attempts never write the same file at
// once (which raised EBUSY on Windows).
let downloadInFlight: Promise<string> | null = null;

function setState(patch: Partial<TunnelState>): void {
  runtime().state = { ...runtime().state, ...patch };
}

/**
 * Start the quick tunnel pointing at `http://127.0.0.1:<port>`. Resolves once
 * the public URL is known (or throws with a readable message). Idempotent: a
 * second call while running/starting returns the current state.
 */
export function startTunnel(port: number): TunnelState {
  const rt = runtime();
  if (rt.state.status === "running" || rt.state.status === "starting") return getTunnelState();

  setState({ status: "starting", phase: "idle", error: null, url: null, hostname: null, startedAt: null });
  // Kick off the work in the background and return at once, so the Settings
  // button never blocks on a download or a slow network; the panel polls state.
  void runStart(port);
  return getTunnelState();
}

async function runStart(port: number): Promise<void> {
  const rt = runtime();
  let bin: { path: string; system: boolean };
  try {
    setState({ phase: "downloading" });
    bin = await ensureCloudflared();
    setState({ phase: "connecting" });
  } catch (error) {
    setState({ status: "error", phase: "idle", error: error instanceof Error ? error.message : String(error) });
    return;
  }

  // Give cloudflared the same proxy the download used (its Go runtime reads
  // HTTPS_PROXY/ALL_PROXY), so the tunnel connects through the local 梯子 too.
  const proxy = await resolveOutboundProxy();
  await new Promise<void>((resolve) => {
    const child = spawn(bin.path, ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", `http://127.0.0.1:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
      env: proxy
        ? { ...process.env, HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy }
        : process.env,
    }) as ChildProcess & { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream };
    rt.child = child;
    setState({ usingSystemBinary: bin.system });

    let settled = false;
    const finish = (patch: Partial<TunnelState>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setState(patch);
      resolve();
    };

    // Keep cloudflared's own words: when it cannot reach the edge ("Failed to
    // initialize DNS local resolver", "dial tcp … i/o timeout") that line is the
    // only useful thing to show, instead of a bare timeout.
    let lastLine = "";
    const scan = (chunk: Buffer) => {
      const text = chunk.toString();
      for (const rawLine of text.split(String.fromCharCode(10))) {
        const line = rawLine.endsWith(String.fromCharCode(13)) ? rawLine.slice(0, -1) : rawLine;
        // Drop ANSI colour codes and other control characters.
        const trimmed = line.split("").filter((ch) => ch >= " ").join("").trim();
        if (trimmed) lastLine = trimmed.slice(0, 300);
      }
      const match = text.match(TRYCLOUDFLARE_URL);
      if (match) {
        const url = match[0];
        const hostname = new URL(url).hostname;
        addDynamicHost(hostname);
        finish({ status: "running", phase: "idle", url, hostname, error: null, startedAt: Date.now() });
      }
    };
    const withDetail = (message: string) => (lastLine ? `${message} (cloudflared: ${lastLine})` : message);
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);

    child.on("error", (error) => {
      finish({ status: "error", error: withDetail(error instanceof Error ? error.message : String(error)) });
    });
    child.on("exit", (code) => {
      const wasRunning = runtime().state.status === "running";
      rt.child = null;
      const host = runtime().state.hostname;
      if (host) removeDynamicHost(host);
      if (wasRunning) {
        setState({ status: "stopped", url: null, hostname: null, startedAt: null });
      } else if (!settled) {
        finish({ status: "error", error: withDetail(`cloudflared exited with code ${code ?? "unknown"} before a URL was ready.`) });
      }
    });

    const timer = setTimeout(() => {
      if (settled) return;
      try { child.kill(); } catch { /* ignore */ }
      finish({ status: "error", error: withDetail("Timed out waiting for the tunnel URL (network may be blocking Cloudflare).") });
    }, START_TIMEOUT_MS);
    timer.unref?.();
  });
}

/** Stop the tunnel and forget its hostname. */
export function stopTunnel(): TunnelState {
  const rt = runtime();
  const child = rt.child;
  if (child) {
    try { child.kill(); } catch { /* ignore */ }
    rt.child = null;
  }
  if (rt.state.hostname) removeDynamicHost(rt.state.hostname);
  rt.starting = null;
  rt.state = { status: "stopped", url: null, hostname: null, error: null, startedAt: null, usingSystemBinary: false, binaryInstalled: false, phase: "idle" };
  return getTunnelState();
}

/** Wait for a killed child to actually exit (Windows keeps its image locked briefly). */
function waitForExit(child: ChildProcess | null, timeoutMs = 5000): Promise<void> {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { child.removeListener("exit", onExit); resolve(); }, timeoutMs);
    child.once("exit", onExit);
  });
}

/**
 * Uninstall: stop the tunnel and delete the downloaded binary.
 *
 * The delete is retried: on Windows a just-killed process keeps its image locked
 * for a moment, and a single `rmSync` after `kill()` reported success while
 * leaving 53 MB behind. `binaryInstalled` in the returned state tells the panel
 * whether it really went away.
 */
export async function uninstallTunnel(): Promise<TunnelState> {
  const child = runtime().child;
  if (child) {
    try { child.kill(); } catch { /* ignore */ }
  }
  await waitForExit(child);
  stopTunnel();
  const path = storedBinaryPath();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (!existsSync(path)) break;
    try {
      rmSync(path, { force: true });
    } catch {
      // still locked; wait and retry
    }
    if (!existsSync(path)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return getTunnelState();
}
