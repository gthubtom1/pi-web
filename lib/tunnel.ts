import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { resolveAgentDir } from "./agent-dir";
import { resolveOutboundProxy } from "./local-proxy";
import { addDynamicHost, removeDynamicHost } from "./dynamic-hosts";
import { readTunnelConfig } from "./tunnel-config";

/**
 * The public tunnel: `cloudflared` exposing this server to a phone on another
 * network (no public IP, CGNAT). Outbound-only, free.
 *
 * It is a Cloudflare **quick tunnel**: a random `https://<name>.trycloudflare.com`
 * address, no account and no token. The address is stable while the process lives
 * and changes when it restarts; that is the trade it makes, and the reason the
 * panel always shows the address to copy instead of trusting the browser history.
 * (A named tunnel with an operator token and a fixed hostname was built and then
 * removed: its Cloudflare side was never usable here, and a fixed address is what
 * Tailscale already provides.)
 *
 * Lifecycle is a singleton on globalThis: start/stop from Settings or from
 * autoStart at boot, and the exact hostname is registered with request-security
 * only while it is up. A tunnel that was running and then died is restarted with
 * an exponential backoff (B1), keeping the address the phone is already on.
 */

export type TunnelStatus = "stopped" | "starting" | "running" | "error";
/** What a "starting" tunnel is busy with, so the panel can say something useful. */
export type TunnelPhase = "idle" | "downloading" | "connecting";

export interface TunnelState {
  status: TunnelStatus;
  /** The address to open: the quick tunnel's random URL. */
  url: string | null;
  /** The exact hostname request-security trusts while the tunnel is up. */
  hostname: string | null;
  error: string | null;
  startedAt: number | null;
  phase: TunnelPhase;
  /** True when cloudflared was found on PATH (vs. downloaded to the agent dir). */
  usingSystemBinary: boolean;
  /** Whether the downloaded binary is on disk (the panel shows Install/Uninstall from it). */
  binaryInstalled: boolean;
  /** How many times a once-running tunnel has been restarted by the keepalive. */
  restarts: number;
  /** True while the keepalive is waiting to try again. */
  restarting: boolean;
  /** Whether `pi-web` starts this tunnel by itself (the saved setting). */
  autoStart: boolean;
}

interface TunnelRuntime {
  child: ChildProcess | null;
  state: TunnelState;
  starting: Promise<TunnelState> | null;
  /** The operator wants a tunnel up: an unexpected exit is restarted. */
  desired: boolean;
  /** Port to point the tunnel at, remembered for restarts. */
  port: number | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  restartAttempt: number;
  /** Set while stopTunnel() tears the child down, so its exit is not "unexpected". */
  stopping: boolean;
  /**
   * Bumped by every start and stop. An `await` inside runStart (a download, a
   * proxy probe) must not spawn a child for a start the operator already
   * cancelled or replaced.
   */
  generation: number;
}

declare global {
  var __piWebTunnel: TunnelRuntime | undefined;
}

const TRYCLOUDFLARE_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const START_TIMEOUT_MS = 45_000;
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;

function initialState(): TunnelState {
  const config = readTunnelConfig();
  return {
    status: "stopped",
    url: null,
    hostname: null,
    error: null,
    startedAt: null,
    usingSystemBinary: false,
    binaryInstalled: false,
    phase: "idle",
    restarts: 0,
    restarting: false,
    autoStart: config.autoStart,
  };
}

function runtime(): TunnelRuntime {
  if (!globalThis.__piWebTunnel) {
    globalThis.__piWebTunnel = {
      child: null,
      state: initialState(),
      starting: null,
      desired: false,
      port: null,
      restartTimer: null,
      restartAttempt: 0,
      stopping: false,
      generation: 0,
    };
  }
  return globalThis.__piWebTunnel;
}

export function getTunnelState(): TunnelState {
  const rt = runtime();
  // autoStart lives in the config file, which Settings writes directly; read it here
  // so the panel never shows a stale switch.
  const config = readTunnelConfig();
  if (config.autoStart !== rt.state.autoStart) rt.state.autoStart = config.autoStart;
  return { ...rt.state, binaryInstalled: existsSync(storedBinaryPath()) };
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

/** Drop a hostname this tunnel registered, if any (exact name only). */
function unregisterHost(hostname: string | null): void {
  if (hostname) removeDynamicHost(hostname);
}

function clearRestart(): void {
  const rt = runtime();
  if (rt.restartTimer) clearTimeout(rt.restartTimer);
  rt.restartTimer = null;
  if (rt.state.restarting) setState({ restarting: false });
}

/**
 * Start the tunnel described by the saved config, pointing at
 * `http://127.0.0.1:<port>`. Resolves at once (the panel polls state);
 * idempotent while one is running or starting.
 */
export function startTunnel(port: number): TunnelState {
  const rt = runtime();
  if (rt.state.status === "running" || rt.state.status === "starting") return getTunnelState();

  const config = readTunnelConfig();
  rt.desired = true;
  rt.port = port;
  rt.restartAttempt = 0;
  rt.generation += 1;
  clearRestart();
  setState({
    status: "starting",
    phase: "idle",
    error: null,
    url: null,
    hostname: null,
    startedAt: null,
    autoStart: config.autoStart,
    restarts: 0,
  });
  void runStart(port, false);
  return getTunnelState();
}

/** Boot-time autoStart (B2): bring the tunnel up when the operator asked for it. */
export function autoStartTunnel(port: number): TunnelState | null {
  if (!readTunnelConfig().autoStart) return null;
  return startTunnel(port);
}

/** Stop the tunnel, cancel any pending restart, and forget its hostname. */
export function stopTunnel(): TunnelState {
  const rt = runtime();
  rt.desired = false;
  clearRestart();
  rt.restartAttempt = 0;
  rt.generation += 1;
  rt.stopping = true;
  const child = rt.child;
  if (child) {
    try { child.kill(); } catch { /* ignore */ }
    rt.child = null;
  }
  unregisterHost(rt.state.hostname);
  rt.starting = null;
  // autoStart comes from the config file, not from the state of the tunnel that
  // just went down: Settings is what decides it.
  rt.state = { ...initialState(), restarts: rt.state.restarts };
  rt.stopping = false;
  return getTunnelState();
}

/** Exponential backoff for a tunnel that was running and then exited (B1). */
function scheduleRestart(reason: string): void {
  const rt = runtime();
  if (!rt.desired || rt.port === null) return;
  const attempt = (rt.restartAttempt += 1);
  const delay = Math.min(RESTART_BASE_MS * 2 ** (attempt - 1), RESTART_MAX_MS);
  clearRestart();
  setState({ status: "starting", phase: "connecting", restarting: true, error: reason, restarts: rt.state.restarts });
  rt.restartTimer = setTimeout(() => {
    rt.restartTimer = null;
    if (!rt.desired) return;
    setState({ restarting: false });
    void runStart(rt.port as number, true);
  }, delay);
  rt.restartTimer.unref?.();
}

async function runStart(port: number, isRestart: boolean): Promise<void> {
  const rt = runtime();
  const generation = rt.generation;
  rt.port = port;
  rt.starting = null;

  let bin: { path: string; system: boolean };
  try {
    setState({ phase: "downloading" });
    bin = await ensureCloudflared();
    if (rt.generation !== generation) return;
    setState({ phase: "connecting" });
  } catch (error) {
    if (rt.generation !== generation) return;
    setState({ status: "error", phase: "idle", error: error instanceof Error ? error.message : String(error) });
    return;
  }

  // Give cloudflared the same proxy the download used (its Go runtime reads
  // HTTPS_PROXY/ALL_PROXY), so the tunnel connects through the local 梯子 too.
  const proxy = await resolveOutboundProxy();
  if (rt.generation !== generation) return;
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (proxy) {
    env.HTTPS_PROXY = proxy;
    env.HTTP_PROXY = proxy;
    env.ALL_PROXY = proxy;
  }
  const args = ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", `http://127.0.0.1:${port}`];

  await new Promise<void>((resolve) => {
    const child = spawn(bin.path, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
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
        const previous = runtime().state.hostname;
        if (previous && previous !== hostname) unregisterHost(previous);
        finish({
          status: "running",
          phase: "idle",
          url,
          hostname,
          error: null,
          startedAt: runtime().state.startedAt ?? Date.now(),
          restarting: false,
          restarts: runtime().state.restarts + (isRestart ? 1 : 0),
        });
      }
    };
    const withDetail = (message: string) => (lastLine ? `${message} (cloudflared: ${lastLine})` : message);
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);

    child.on("error", (error) => {
      finish({ status: "error", error: withDetail(error instanceof Error ? error.message : String(error)) });
    });
    child.on("exit", (code) => {
      const wasRunning = runtime().state.status === "running" || runtime().state.restarting === true;
      const wasStopping = runtime().stopping;
      rt.child = null;
      unregisterHost(runtime().state.hostname);
      if (settled) {
        // Already running: an unexpected exit restarts it (B1) instead of going dark.
        if (wasRunning && rt.desired && !wasStopping) {
          scheduleRestart(withDetail(`cloudflared exited (code ${code ?? "unknown"}); reconnecting`));
        } else if (wasRunning) {
          setState({ status: "stopped", url: null, hostname: null, startedAt: null, restarting: false });
        }
        return;
      }
      if (wasRunning && rt.desired && !wasStopping) {
        scheduleRestart(withDetail(`cloudflared exited (code ${code ?? "unknown"}); reconnecting`));
        finish({ status: "starting", phase: "connecting", restarting: true });
        return;
      }
      finish({ status: "error", error: withDetail(`cloudflared exited with code ${code ?? "unknown"} before a URL was ready.`) });
    });

    const timer = setTimeout(() => {
      if (settled) return;
      try { child.kill(); } catch { /* ignore */ }
      finish({ status: "error", error: withDetail("Timed out waiting for the tunnel URL (network may be blocking Cloudflare).") });
    }, START_TIMEOUT_MS);
    timer.unref?.();
  });
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

/**
 * Kill the child when this process goes away, so a SIGTERM from the terminal or a
 * closing dev server never leaves an orphaned tunnel pointing at a dead port.
 */
export function installTunnelShutdownHook(): void {
  const rt = runtime();
  if ((rt as TunnelRuntime & { shutdownHooked?: boolean }).shutdownHooked) return;
  (rt as TunnelRuntime & { shutdownHooked?: boolean }).shutdownHooked = true;
  const shutdown = () => {
    const child = runtime().child;
    runtime().desired = false;
    clearRestart();
    if (child) {
      try { child.kill(); } catch { /* ignore */ }
    }
  };
  process.once("exit", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
