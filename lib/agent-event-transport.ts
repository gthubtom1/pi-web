import type { AgentEventSourceLike } from "./agent-event-connection";

/**
 * How the browser receives live agent events.
 *
 *   auto — a WebSocket first, SSE when the socket cannot be established. This is
 *          the default: a WebSocket survives the hop a phone makes through a
 *          carrier and a tunnel, which is where an SSE stream goes quiet;
 *   ws   — WebSocket only (an operator debugging the socket, or a network where
 *          SSE is known to be buffered);
 *   poll — no push channel at all: the transcript is re-read on a short interval.
 *          The last resort, and the only mode that works through a proxy that
 *          buffers every chunked response.
 *
 * Whichever mode is chosen, `hooks/useAgentSession.ts` additionally re-reads the
 * transcript when the push channel has been silent for a few seconds, so a stalled
 * stream shows the growing conversation instead of nothing until the turn ends.
 */
export const REALTIME_MODES = ["auto", "ws", "poll"] as const;
export type RealtimeMode = (typeof REALTIME_MODES)[number];
export const DEFAULT_REALTIME_MODE: RealtimeMode = "auto";

export function isRealtimeMode(value: unknown): value is RealtimeMode {
  return typeof value === "string" && (REALTIME_MODES as readonly string[]).includes(value);
}

/** The SSE endpoint (relative, so it works behind any host). */
export function agentEventsPath(sessionId: string): string {
  return `/api/agent/${encodeURIComponent(sessionId)}/events`;
}

/**
 * The WebSocket endpoint. Derived from the page's own origin — scheme, host and
 * port — never from a configured name: the socket must go wherever the page came
 * from, including a tunnel hostname.
 */
export function agentEventsSocketUrl(origin: string, sessionId: string): string {
  const trimmed = origin.replace(/\/+$/, "");
  const authority = trimmed.replace(/^https?:\/\//i, "");
  const scheme = /^https:/i.test(trimmed) ? "wss" : "ws";
  return `${scheme}://${authority}/api/agent/${encodeURIComponent(sessionId)}/ws`;
}

/** WebSocket.OPEN is 1, the same as EventSource.OPEN. */
const SOCKET_OPEN = 1;
const SOCKET_CONNECTING = 0;

export interface WebSocketSourceOptions {
  /** Called once when this socket cannot be used; the factory stops trying. */
  onUnavailable?: () => void;
}

/**
 * A WebSocket dressed as an event source, so the connection class does not have
 * two transports to reason about. Frames are already the JSON payload of one
 * agent event (the server forwards each SSE `data:` line as one frame).
 */
export function createWebSocketSource(url: string, options: WebSocketSourceOptions = {}): AgentEventSourceLike {
  const socket = new WebSocket(url);
  let closedByUs = false;
  let unavailableReported = false;
  const reportUnavailable = () => {
    if (unavailableReported) return;
    unavailableReported = true;
    options.onUnavailable?.();
  };

  const source: AgentEventSourceLike = {
    get readyState() {
      if (socket.readyState === SOCKET_OPEN) return SOCKET_OPEN;
      return socket.readyState === SOCKET_CONNECTING ? SOCKET_CONNECTING : 3;
    },
    onmessage: null,
    onerror: null,
    close() {
      closedByUs = true;
      try {
        socket.close();
      } catch {
        // Already gone: nothing to close.
      }
    },
  };

  socket.onmessage = (event) => {
    // A binary frame is not part of this protocol; ignore it rather than choke.
    if (typeof event.data !== "string" || event.data.length === 0) return;
    source.onmessage?.({ data: event.data } as MessageEvent<string>);
  };
  socket.onerror = () => reportUnavailable();
  socket.onclose = () => {
    if (closedByUs) return;
    reportUnavailable();
    source.onerror?.(new Event("error"));
  };

  return source;
}

/**
 * A push-channel stand-in for `poll` mode: it reports the connection as ready (so
 * sending a prompt does not wait for a stream that will never exist) and then
 * stays silent. Message growth comes from the transcript poll instead.
 */
export function createPollingSource(): AgentEventSourceLike {
  let readyState = SOCKET_OPEN;
  const source: AgentEventSourceLike = {
    get readyState() {
      return readyState;
    },
    onmessage: null,
    onerror: null,
    close() {
      readyState = 3;
    },
  };
  // The readiness handshake the connection class waits for, without a stream.
  setTimeout(() => {
    if (readyState !== SOCKET_OPEN) return;
    source.onmessage?.({ data: JSON.stringify({ type: "connected" }) } as MessageEvent<string>);
  }, 0);
  return source;
}

export interface AgentEventSourceFactoryOptions {
  /** Read at every connection: a change in Settings applies to the next one. */
  mode(): RealtimeMode;
  /** Absolute ws:// or wss:// URL for one session. */
  socketUrl(sessionId: string): string;
  /** The SSE endpoint, relative to the page. */
  eventsPath(sessionId: string): string;
  createEventSource(path: string): AgentEventSourceLike;
  createSocket?(url: string, options: WebSocketSourceOptions): AgentEventSourceLike;
  createPoll?: () => AgentEventSourceLike;
  /** Called the first time a socket proves unusable, so the choice can be logged. */
  onSocketUnavailable?(reason: string): void;
}

/**
 * Build `createSource` for AgentEventConnection. The WebSocket is tried first and
 * remembered as broken after one failure: a browser that cannot open the socket
 * falls back to SSE for the rest of the page's life instead of paying a failed
 * handshake per reconnect.
 */
export function createAgentEventSourceFactory(
  options: AgentEventSourceFactoryOptions,
): (sessionId: string) => AgentEventSourceLike {
  let socketUnusable = false;

  return (sessionId: string): AgentEventSourceLike => {
    const mode = options.mode();
    if (mode === "poll") return (options.createPoll ?? createPollingSource)();
    if (mode === "ws") {
      const createSocket = options.createSocket ?? createWebSocketSource;
      return createSocket(options.socketUrl(sessionId), {
        onUnavailable: () => options.onSocketUnavailable?.("websocket"),
      });
    }
    if (!socketUnusable) {
      const createSocket = options.createSocket ?? createWebSocketSource;
      return createSocket(options.socketUrl(sessionId), {
        onUnavailable: () => {
          if (socketUnusable) return;
          socketUnusable = true;
          options.onSocketUnavailable?.("websocket");
        },
      });
    }
    return options.createEventSource(options.eventsPath(sessionId));
  };
}
