import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const transport = await jiti.import("./agent-event-transport.ts");

const OPEN = 1;

/** The shape AgentEventConnection drives, faked per test. */
class FakeSource {
  readyState = OPEN;
  onmessage = null;
  onerror = null;
  closed = 0;
  constructor(name) {
    this.name = name;
  }
  close() {
    this.closed += 1;
    this.readyState = 2;
  }
}

test("the socket URL follows the page's own origin, never a configured name", () => {
  const { agentEventsSocketUrl } = transport;
  assert.equal(
    agentEventsSocketUrl("https://pi.example.com", "abc-123"),
    "wss://pi.example.com/api/agent/abc-123/ws",
  );
  assert.equal(
    agentEventsSocketUrl("http://127.0.0.1:30141", "abc"),
    "ws://127.0.0.1:30141/api/agent/abc/ws",
  );
  // A trailing slash on the origin must not produce a double slash.
  assert.equal(agentEventsSocketUrl("https://host/", "x"), "wss://host/api/agent/x/ws");
  // Ids are URL-encoded, so any session id survives.
  assert.equal(agentEventsSocketUrl("http://h:1", "a/b c"), "ws://h:1/api/agent/a%2Fb%20c/ws");
});

test("the SSE path is relative, so it works behind any host", () => {
  assert.equal(transport.agentEventsPath("s1"), "/api/agent/s1/events");
});

test("mode parsing accepts exactly auto, ws and poll", () => {
  const { isRealtimeMode } = transport;
  for (const mode of transport.REALTIME_MODES) assert.equal(isRealtimeMode(mode), true);
  assert.equal(isRealtimeMode("socket"), false);
  assert.equal(isRealtimeMode(undefined), false);
  assert.equal(isRealtimeMode(1), false);
  assert.equal(transport.DEFAULT_REALTIME_MODE, "auto");
});

test("auto prefers the socket, then remembers it as broken and uses SSE", () => {
  const sources = [];
  const fallbacks = [];
  const createSource = transport.createAgentEventSourceFactory({
    mode: () => "auto",
    socketUrl: (sid) => `wss://host/api/agent/${sid}/ws`,
    eventsPath: transport.agentEventsPath,
    createSocket: (url, options) => {
      const source = new FakeSource(`socket:${url}`);
      source.onUnavailable = options.onUnavailable;
      sources.push(source);
      return source;
    },
    createEventSource: (path) => {
      const source = new FakeSource(`sse:${path}`);
      sources.push(source);
      return source;
    },
    onSocketUnavailable: (reason) => fallbacks.push(reason),
  });

  const first = createSource("s1");
  assert.equal(first.name, "socket:wss://host/api/agent/s1/ws");

  // The connection reports the failure, and the next attempt is SSE.
  first.onUnavailable();
  const second = createSource("s1");
  assert.equal(second.name, "sse:/api/agent/s1/events");
  assert.deepEqual(fallbacks, ["websocket"]);

  // Once fallen back, it stays on SSE: no failed handshake per reconnect.
  assert.equal(createSource("s1").name, "sse:/api/agent/s1/events");
});

test("ws only never falls back", () => {
  const created = [];
  const createSource = transport.createAgentEventSourceFactory({
    mode: () => "ws",
    socketUrl: (sid) => `wss://host/${sid}`,
    eventsPath: transport.agentEventsPath,
    createSocket: (url, options) => {
      const source = new FakeSource(`socket:${url}`);
      source.onUnavailable = options.onUnavailable;
      created.push(source);
      return source;
    },
    createEventSource: (path) => {
      created.push(new FakeSource(`sse:${path}`));
      return new FakeSource(`sse:${path}`);
    },
  });
  const source = createSource("s9");
  assert.equal(source.name, "socket:wss://host/s9");
  // The failure is reported; the transport stays on the socket anyway.
  source.onUnavailable();
  assert.equal(createSource("s9").name, "socket:wss://host/s9");
  assert.equal(created.filter((entry) => entry.name.startsWith("sse:")).length, 0);
});

test("poll mode opens no push channel at all", () => {
  let eventSources = 0;
  let sockets = 0;
  const createSource = transport.createAgentEventSourceFactory({
    mode: () => "poll",
    socketUrl: () => "wss://host/never",
    eventsPath: transport.agentEventsPath,
    createSocket: () => { sockets += 1; return new FakeSource("socket"); },
    createEventSource: () => { eventSources += 1; return new FakeSource("sse"); },
  });
  const source = createSource("s1");
  assert.ok(source);
  assert.equal(sockets, 0);
  assert.equal(eventSources, 0);
});

test("the polling stand-in reports readiness, then stays quiet", async () => {
  const source = transport.createPollingSource();
  assert.equal(source.readyState, OPEN);
  const messages = [];
  source.onmessage = (event) => messages.push(JSON.parse(event.data));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(messages, [{ type: "connected" }]);

  // A closed stand-in must not report readiness afterwards.
  const closed = transport.createPollingSource();
  const late = [];
  closed.onmessage = (event) => late.push(event.data);
  closed.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(late, []);
});
