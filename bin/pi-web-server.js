#!/usr/bin/env node
"use strict";

/**
 * Pi Web's server: Next's request handler plus one WebSocket endpoint.
 *
 * Why a custom server at all: Next's route handlers cannot answer an HTTP
 * `upgrade`, so a live-event WebSocket has to be handled one layer below it.
 * Everything that is not `/api/agent/<id>/ws` goes to Next untouched — the
 * custom server is an extra socket handler, not a second app.
 *
 * The socket is a *transport* swap, nothing more: after authorizing the request
 * the same way the HTTP app does (the browser's cookie, replayed at the app over
 * loopback with the original Host, so pairing codes / PI_WEB_PASSWORD / the
 * tunnel-host scope all apply unchanged), it opens the existing SSE stream
 * against 127.0.0.1 and forwards each `data:` payload as one text frame. When the
 * browser's socket closes, that SSE request is aborted, so no agent runs on
 * behalf of a page that is gone.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require("node:http");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { acceptKey, encodeText, encodePing, encodePong, encodeClose, createFrameParser, OPCODE } = require("../lib/ws-protocol.cjs");

const pkgDir = path.join(__dirname, "..");
const port = Number(process.env.PI_WEB_PORT || process.env.PORT || 30141);
const hostname = process.env.PI_WEB_HOSTNAME || "0.0.0.0";

// `next({ dev: false })` insists on a production NODE_ENV, exactly as `next start`
// sets it before loading the app.
process.env.NODE_ENV = process.env.NODE_ENV || "production";

const WS_PATH = /^\/api\/agent\/([^/]+)\/ws$/;
/** No event for this long means the tunnel's proxy forgot the socket. */
const WS_PING_INTERVAL_MS = 20_000;
/** The SSE stream is what actually starts the session; do not hang forever on it. */
const SSE_CONNECT_TIMEOUT_MS = 30_000;

function logLine(text) {
  process.stdout.write(`${text}\n`);
}

function rawRefusal(socket, status, reason, body) {
  const payload = body ? `${body}\n` : "";
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n`
    + "Content-Type: text/plain; charset=utf-8\r\n"
    + `Content-Length: ${Buffer.byteLength(payload)}\r\n`
    + "Cache-Control: no-store\r\n"
    + "Connection: close\r\n\r\n"
    + payload,
  );
  socket.destroy();
}

/**
 * Is this browser request authenticated? Ask the app itself: one `GET /api/sessions`
 * over loopback that carries the browser's Cookie and its original Host header, so
 * proxy.ts answers with the very same rules an ordinary request gets (loopback pass,
 * PI_WEB_PASSWORD, the pairing code of the scope that Host belongs to, the tunnel
 * hostname allow-list). Reimplementing those rules here would be a second, driftable
 * copy of the auth decisions.
 */
function isAuthorized(cookieHeader, hostHeader) {
  return new Promise((resolve) => {
    const headers = { accept: "application/json" };
    if (cookieHeader) headers.cookie = cookieHeader;
    if (hostHeader) headers.host = hostHeader;
    const request = http.request(
      { host: "127.0.0.1", port, method: "GET", path: "/api/sessions", headers, timeout: 15_000 },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.on("timeout", () => { request.destroy(); resolve(false); });
    request.on("error", () => resolve(false));
    request.end();
  });
}

/** Split an SSE byte stream into the payloads of its `data:` lines. */
function createSseParser(onData) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      // Frames end with a blank line; tolerate CRLF from an intermediary.
      const separator = /\r?\n\r?\n/;
      let match = separator.exec(buffer);
      while (match) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const dataLines = [];
        for (const line of block.split(/\r?\n/)) {
          // A `:comment` line is SSE's keepalive and carries no payload.
          if (!line.startsWith("data:")) continue;
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        if (dataLines.length > 0) onData(dataLines.join("\n"));
        match = separator.exec(buffer);
      }
      // A stream that never sends a blank line must not grow without bound.
      if (buffer.length > 4 * 1024 * 1024) buffer = "";
    },
  };
}

/**
 * One live connection: authorize, upgrade, bridge the app's own SSE stream.
 */
async function handleUpgrade(request, socket, head) {
  let socketClosed = false;
  const closeSocket = () => {
    if (socketClosed) return;
    socketClosed = true;
    try { socket.destroy(); } catch { /* already gone */ }
  };
  socket.on("error", closeSocket);
  socket.on("close", closeSocket);

  let pathname;
  try {
    pathname = new URL(request.url || "/", "http://localhost").pathname;
  } catch {
    rawRefusal(socket, 400, "Bad Request");
    return;
  }
  const match = WS_PATH.exec(pathname);
  if (!match) {
    // Nothing else in Pi Web upgrades a connection. A stray one is a wrong client,
    // not a reason to keep a half-open socket.
    rawRefusal(socket, 404, "Not Found");
    return;
  }

  const key = request.headers["sec-websocket-key"];
  const version = request.headers["sec-websocket-version"];
  const upgrade = String(request.headers.upgrade || "");
  const connection = String(request.headers.connection || "");
  if (
    !key
    || version !== "13"
    // `Upgrade: websocket`, and a `Connection` that lists `upgrade`.
    || !/^websocket$/i.test(upgrade)
    || !/(^|,)\s*upgrade\s*(,|$)/i.test(connection)
  ) {
    rawRefusal(socket, 400, "Bad Request", "Expected a WebSocket handshake");
    return;
  }

  // A browser always sends Origin on a WebSocket handshake. Refuse one that names a
  // different site: the socket carries a session cookie, and only the page's own
  // origin may open it (the same stance proxy.ts takes for API requests).
  const origin = request.headers.origin;
  if (origin) {
    let originHost = null;
    try {
      originHost = new URL(String(origin)).host.toLowerCase();
    } catch {
      originHost = null;
    }
    if (!originHost || originHost !== String(request.headers.host || "").toLowerCase()) {
      rawRefusal(socket, 403, "Forbidden", "Cross-origin live connection refused");
      return;
    }
  }

  const authorized = await isAuthorized(request.headers.cookie, request.headers.host);
  if (socketClosed) return;
  if (!authorized) {
    rawRefusal(socket, 401, "Unauthorized", "Authentication required");
    return;
  }

  let sessionId;
  try {
    sessionId = decodeURIComponent(match[1]);
  } catch {
    rawRefusal(socket, 400, "Bad Request");
    return;
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) {
    rawRefusal(socket, 400, "Bad Request");
    return;
  }

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n"
    + "Upgrade: websocket\r\n"
    + "Connection: Upgrade\r\n"
    + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  socket.setNoDelay(true);

  const sseHeaders = { accept: "text/event-stream", "cache-control": "no-cache" };
  if (request.headers.cookie) sseHeaders.cookie = request.headers.cookie;
  // The original authority, so the app picks the same auth scope and the same
  // pairing code an ordinary request from this browser would use.
  sseHeaders.host = request.headers.host || `127.0.0.1:${port}`;

  const upstream = http.request({
    host: "127.0.0.1",
    port,
    method: "GET",
    path: `/api/agent/${encodeURIComponent(sessionId)}/events`,
    headers: sseHeaders,
  });
  let upstreamResponse = null;
  let finished = false;

  const finish = (code) => {
    if (finished) return;
    finished = true;
    clearInterval(pingTimer);
    clearTimeout(connectTimer);
    try { upstream.destroy(); } catch { /* ignore */ }
    if (upstreamResponse) {
      try { upstreamResponse.destroy(); } catch { /* ignore */ }
    }
    if (!socketClosed) {
      try { socket.write(encodeClose(code)); } catch { /* ignore */ }
      socket.end();
      closeSocket();
    }
  };

  const send = (payload) => {
    if (finished || socketClosed) return;
    try {
      socket.write(encodeText(payload));
    } catch {
      finish(1011);
    }
  };

  const parser = createSseParser(send);

  const pingTimer = setInterval(() => {
    if (finished || socketClosed) return;
    try {
      socket.write(encodePing(Buffer.alloc(0)));
    } catch {
      finish(1011);
    }
  }, WS_PING_INTERVAL_MS);
  pingTimer.unref?.();

  const connectTimer = setTimeout(() => {
    // No answer from the app in half a minute: the browser should retry rather
    // than hold a socket that will never carry anything.
    if (!upstreamResponse) finish(1011);
  }, SSE_CONNECT_TIMEOUT_MS);
  connectTimer.unref?.();

  upstream.on("response", (response) => {
    upstreamResponse = response;
    clearTimeout(connectTimer);
    if (response.statusCode !== 200) {
      // 404 (unknown session) / 401 (auth) / 500: report it as an abnormal close
      // so the client falls back to its own request path and gets a real answer.
      response.resume();
      finish(response.statusCode === 404 ? 1008 : 1011);
      return;
    }
    response.setEncoding("utf8");
    response.on("data", (chunk) => parser.push(chunk));
    response.on("end", () => finish(1000));
    response.on("error", () => finish(1011));
  });
  upstream.on("error", () => finish(1011));
  upstream.end();

  // The browser side: read its frames so a close is seen at once, answer pings,
  // and unmask whatever else it sends (the app never expects client text).
  const frames = createFrameParser();
  const onData = (chunk) => {
    let parsed;
    try {
      parsed = frames.push(chunk);
    } catch {
      finish(1009);
      return;
    }
    for (const frame of parsed) {
      if (frame.opcode === OPCODE.close) {
        finish(1000);
        return;
      }
      if (frame.opcode === OPCODE.ping) {
        try { socket.write(encodePong(frame.payload)); } catch { finish(1011); }
        return;
      }
      // Text/binary from the browser is ignored: this channel is one-way by design.
    }
  };
  socket.on("data", onData);
  if (head && head.length) onData(head);
  socket.on("close", () => finish(1000));
  socket.on("error", () => finish(1011));
}

async function main() {
  let nextFactory;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nextFactory = require(require.resolve("next", { paths: [pkgDir] }));
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nextFactory = require(path.join(pkgDir, "node_modules", "next"));
  }
  const app = nextFactory({ dev: false, hostname, port, dir: pkgDir });
  const preparedAt = Date.now();
  await app.prepare();
  const handle = app.getRequestHandler();

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      console.error("[pi-web] request failed:", error instanceof Error ? error.message : error);
      if (!response.headersSent) {
        response.statusCode = 500;
        response.end("Internal Server Error");
      } else {
        response.end();
      }
    });
  });
  // Event streams and long uploads outlive Node's 5-minute default socket timeout.
  server.keepAliveTimeout = 72_000;
  server.headersTimeout = 75_000;
  server.requestTimeout = 0;
  server.timeout = 0;

  server.on("upgrade", (request, socket, head) => {
    handleUpgrade(request, socket, head).catch((error) => {
      console.error("[pi-web] live socket failed:", error instanceof Error ? error.message : error);
      try { socket.destroy(); } catch { /* ignore */ }
    });
  });

  server.on("error", (error) => {
    console.error(`[pi-web] server error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });

  server.listen(port, hostname, () => {
    // Same wording as `next start`, so bin/pi-web.js keeps recognising readiness.
    logLine("  ▲ Next.js (custom server: live events on /api/agent/:id/ws)");
    logLine(`  - ready started server on ${hostname}:${port}, url: http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${port}`);
    logLine(`  ✓ Ready in ${Date.now() - preparedAt}ms`);
  });

  const shutdown = () => {
    try { server.close(); } catch { /* ignore */ }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(`[pi-web] failed to start: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
});
