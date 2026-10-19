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
const os = require("os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getHelpText, parseCommandLine } = require("./pi-web-options");
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

// Remote access is gated by the PAIRING CODES in Settings > Remote access (one for
// the local network, one for the public tunnel); this machine never asks. Only an
// operator-pinned PI_WEB_PASSWORD is mentioned (never its value).
function describeAccess() {
  if (process.env.PI_WEB_PASSWORD !== undefined) {
    if (process.env.PI_WEB_PASSWORD === "") {
      return { lines: ["Remote access: no password (PI_WEB_PASSWORD is empty)."] };
    }
    return { lines: ["Remote access also requires the PI_WEB_PASSWORD you set (not echoed)."] };
  }
  return {
    lines: [
      "Pairing codes for phones: Settings › Remote access (LAN and public tunnel each have one).",
      "This machine needs no code.",
    ],
  };
}

function handlesWildcardHost(hostname) {
  return hostname === "0.0.0.0" || hostname === "::" || hostname === "[::]";
}

function startServer({ port, hostname, openBrowser }) {

  const pkgDir = path.join(__dirname, "..");
  const nextDir = path.join(pkgDir, ".next");

  // Pi Web runs its own small HTTP server (bin/pi-web-server.js): Next answers every
  // ordinary request, and that server additionally handles the live-event WebSocket
  // at /api/agent/:id/ws, which a Next route handler cannot (no `upgrade` there).
  const serverEntry = path.join(__dirname, "pi-web-server.js");

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

  // The hostname and port travel in the environment; the server reads both.
  const child = spawn(process.execPath, [serverEntry], {
    cwd: pkgDir,
    stdio: ["inherit", "pipe", "inherit"],
    env: {
      ...process.env,
      PI_WEB_HOSTNAME: hostname,
      // The server and the tunnel supervisor both need the port the browser uses.
      PI_WEB_PORT: String(port),
    },
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
      const auth = describeAccess();
      process.stdout.write(nl + "  On this machine (no code needed):" + nl + "    " + url + nl);
      if (handlesWildcardHost(hostname)) {
        process.stdout.write("    (Next's \"Network: http://0.0.0.0:...\" line above is the bind address, not a link: browsers refuse it and a proxy answers 502.)" + nl);
      }
      if (handlesWildcardHost(hostname)) {
        const lanUrls = getLanUrls(port);
        if (lanUrls.length > 0) {
          const lines = lanUrls.map((u) => "    " + u).join(nl);
          process.stdout.write(nl + "  From a phone or another device (needs a pairing code):" + nl + lines + nl);
        }
      }
      process.stdout.write(nl + "  " + auth.lines.join(nl + "  ") + nl + nl);
      if (openBrowser) openInBrowser(url);
    }
  });
}
