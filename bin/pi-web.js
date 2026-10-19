#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version");

if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require("crypto");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getHelpText, parseCommandLine } = require("./pi-web-options");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getNextNodeArgs } = require("./pi-web-node-args");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { wireChildProcessLifecycle } = require("./process-lifecycle");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { rotatePreviewSecrets, getRotationWarning } = require("./rotate-preview-secrets");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { openInBrowser } = require("./browser-opener");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRunRecordTracker, getOpenUrl, getRunDir } = require("./run-records");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getPackageVersion, runCommand } = require("./pi-web-commands");

let launchOptions;
try {
  launchOptions = parseCommandLine();
} catch (error) {
  fs.writeSync(
    process.stderr.fd,
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}

if (launchOptions.help) {
  fs.writeSync(process.stdout.fd, getHelpText());
  process.exit(0);
}

if (launchOptions.command === "start") {
  startServer(launchOptions);
} else {
  runCommand(launchOptions).then(
    exitWhenIdle,
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      exitWhenIdle(1);
    },
  );
}

// Leave once the event loop drains instead of calling process.exit() right
// after a fetch(): on Windows, Node.js 23 up to 24.19 / 26.6 can then abort
// with a libuv assertion (UV_HANDLE_CLOSING, win/async.c) while background
// work from the fetch is still winding down (#1174, nodejs/node#56645). The
// unref'd timer only fires if something still holds the loop open.
function exitWhenIdle(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2_000).unref();
}

// Non-internal IPv4 addresses, for telling a phone which LAN URL to open when
// the server binds a wildcard address (0.0.0.0 / ::). Hypervisor/container/
// VPN-tap adapters are skipped the way Settings › Remote access skips them.
function getLanUrls(port) {
  const real = [];
  const virtual = [];
  const virtualIface = /(vmware|virtualbox|vbox|hyper-?v|vethernet|wsl|docker|loopback|npcap|bluetooth|tap-|tun\d|ppp)/i;
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      const list = virtualIface.test(name) ? virtual : real;
      for (const net of nets[name] ?? []) {
        if (net.family !== "IPv4" || net.internal) continue;
        // APIPA / link-local is never a phone-reachable address.
        if (net.address.startsWith("169.254.")) continue;
        list.push(`http://${net.address}:${port}`);
      }
    }
  } catch {
    // ignore
  }
  // A machine whose only private address is virtual still gets a hint.
  return real.length > 0 ? real : virtual;
}

// pi's agent directory, resolved like the SDK's getAgentDir().
function getAgentDir() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return path.join(os.homedir(), ".pi", "agent");
  if (configured === "~") return os.homedir();
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return path.join(os.homedir(), configured.slice(2));
  }
  return configured;
}

/**
 * The password the browser will ask for.
 *   - `PI_WEB_PASSWORD` set and non-empty: the operator's own password (not echoed).
 *   - `PI_WEB_PASSWORD` set but empty: authentication is off.
 *   - otherwise: a strong random secret generated once into
 *     `<agentDir>/pi-web-secret`, printed here so the first login is possible.
 * Same precedence as lib/web-secret.ts, which the server uses.
 */
function describePassword() {
  if (process.env.PI_WEB_PASSWORD !== undefined) {
    if (process.env.PI_WEB_PASSWORD === "") {
      return { kind: "disabled", lines: ["Remote access is open (PI_WEB_PASSWORD is empty): any device may use the agent."] };
    }
    return { kind: "env", lines: ["Remote password: from PI_WEB_PASSWORD (not echoed)."] };
  }
  const dir = getAgentDir();
  const file = path.join(dir, "pi-web-secret");
  // Settings › Remote access can switch authentication off without an env var
  // (Windows cannot set an empty PI_WEB_PASSWORD). Same file the server reads.
  try {
    const authFile = path.join(dir, "pi-web-auth.json");
    if (fs.existsSync(authFile)) {
      const parsed = JSON.parse(fs.readFileSync(authFile, "utf-8"));
      if (parsed?.requirePassword === false) {
        return { kind: "disabled", lines: ["Authentication is off (Settings \u203a Remote access). Anyone who can reach this port may use the agent."] };
      }
    }
  } catch {
    // a corrupt file keeps authentication on, as the server does
  }
  try {
    let secret = "";
    if (fs.existsSync(file)) secret = fs.readFileSync(file, "utf-8").trim();
    if (!secret) {
      secret = crypto.randomBytes(24).toString("base64url");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, `${secret}\n`, { encoding: "utf-8", mode: 0o600 });
      try { fs.chmodSync(file, 0o600); } catch { /* Windows: profile ACLs apply */ }
    }
    return {
      kind: "generated",
      lines: [
        `Remote password: ${secret}`,
        `  stored in ${file} (delete it to rotate)`,
        "  Turn it off in Settings › Remote access if you only use this machine.",
      ],
    };
  } catch (error) {
    return { kind: "error", lines: ["Could not read or create the login secret: " + (error instanceof Error ? error.message : String(error))] };
  }
}

function handlesWildcardHost(hostname) {
  return hostname === "0.0.0.0" || hostname === "::" || hostname === "[::]";
}

function startServer({ port, hostname, openBrowser }) {

  const pkgDir = path.join(__dirname, "..");
  const nextDir = path.join(pkgDir, ".next");

  // Resolve next's CLI entry directly to avoid relying on .bin symlinks (which
  // may not exist when installed via npx).
  let nextBin;
  try {
    nextBin = require.resolve("next/dist/bin/next", { paths: [pkgDir] });
  } catch {
    // Fallback: locate next package root and derive the bin path manually.
    try {
      const nextPkg = require.resolve("next/package.json", { paths: [pkgDir] });
      nextBin = path.join(path.dirname(nextPkg), "dist", "bin", "next");
    } catch {
      nextBin = path.join(pkgDir, "node_modules", "next", "dist", "bin", "next");
    }
  }

  const loopbackHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  // Auth is on by default: a strong random secret is generated on first run and
  // stored in the agent dir (lib/web-secret.ts). Only an explicit empty
  // PI_WEB_PASSWORD turns authentication off.
  const passwordEnabled = process.env.PI_WEB_PASSWORD !== "";

  if (!fs.existsSync(nextDir)) {
    console.error("Build artifacts not found. Please report this issue.");
    process.exit(1);
  }

  // Replace the published preview-mode secrets with fresh random values so the
  // previewModeId baked into the npm tarball cannot be used to skip the proxy
  // (via the x-prerender-revalidate header). Must happen before `next start`.
  const rotation = rotatePreviewSecrets(nextDir);
  if (!rotation.ok) {
    console.warn(getRotationWarning(rotation.reason));
  }

  if (!loopbackHostnames.has(hostname)) {
    if (passwordEnabled) {
      console.warn(
        `Warning: pi-web is listening on ${hostname} with password authentication over HTTP. Use HTTPS or a trusted VPN to protect the password in transit.`,
      );
    } else {
      console.warn(
        `Warning: pi-web is listening on ${hostname} without authentication. Only use this on a trusted network.`,
      );
    }
  }

  const nextArgs = ["start", "-p", port];
  nextArgs.push("-H", hostname);

  // Always run next's JS entry with node directly — avoids .bin symlink issues
  // and path-with-spaces problems on Windows when shell: true is used.
  const child = spawn(process.execPath, getNextNodeArgs(nextBin, nextArgs), {
    cwd: pkgDir,
    stdio: ["inherit", "pipe", "inherit"],
    env: { ...process.env, PI_WEB_HOSTNAME: hostname },
  });
  wireChildProcessLifecycle(child);

  // Port 0 lets the OS pick a port we never learn, so such a server gets no record.
  const runRecord = createRunRecordTracker({
    dir: getRunDir,
    record: {
      pid: process.pid,
      nextPid: child.pid,
      port: Number(port),
      hostname,
      url: getOpenUrl(hostname, port),
      version: getPackageVersion(pkgDir),
      startedAt: new Date().toISOString(),
    },
  });

  let serverReady = false;
  // A wildcard bind is not a browsable address: `http://0.0.0.0:30141` is refused by
  // browsers and answers 502 through a proxy. Open (and print) the loopback name.
  const url = getOpenUrl(hostname, port);

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    if (!serverReady && text.includes("Ready")) {
      serverReady = true;
      if (port !== "0") runRecord.markReady();
      const nl = String.fromCharCode(10);
      // 127.0.0.1, not the wildcard: `Network: http://0.0.0.0:...` (Next's own line)
      // cannot be opened in a browser — through a proxy it answers 502.
      const auth = describePassword();
      process.stdout.write(nl + "  On this machine (no password needed):" + nl + "    " + url + nl);
      if (handlesWildcardHost(hostname)) {
        process.stdout.write("    (Next's \"Network: http://0.0.0.0:...\" line above is the bind address, not a link: browsers refuse it and a proxy answers 502.)" + nl);
      }
      if (handlesWildcardHost(hostname)) {
        const lanUrls = getLanUrls(port);
        if (lanUrls.length > 0) {
          const lines = lanUrls.map((u) => "    " + u).join(nl);
          process.stdout.write(nl + "  From a phone or another device (password needed):" + nl + lines + nl);
        }
      }
      process.stdout.write(nl + "  " + auth.lines.join(nl + "  ") + nl + nl);
      if (openBrowser) openInBrowser(url);
    }
  });
}
