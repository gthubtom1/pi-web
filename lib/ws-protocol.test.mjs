import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  OPCODE,
  acceptKey,
  encodeClose,
  encodePing,
  encodePong,
  encodeText,
  createFrameParser,
} = require("./ws-protocol.cjs");

/** One client frame: masked, as a browser always sends. */
function clientFrame(opcode, payload, mask = Buffer.from([1, 2, 3, 4])) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | body.length;
  } else {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/** Read a server frame back: FIN/opcode, length, payload. */
function readServerFrame(buffer) {
  const opcode = buffer[0] & 0x0f;
  const fin = (buffer[0] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    length = buffer.readUInt32BE(6);
    offset = 10;
  }
  assert.equal(buffer[1] & 0x80, 0, "a server frame is never masked");
  return { opcode, fin, payload: buffer.subarray(offset, offset + length) };
}

test("acceptKey matches the RFC 6455 example handshake", () => {
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  // Tolerates the padding a header may carry.
  assert.equal(acceptKey("  dGhlIHNhbXBsZSBub25jZQ==  "), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("encodes text frames with the short, 16-bit and 64-bit length forms", () => {
  const short = readServerFrame(encodeText("hello"));
  assert.deepEqual(short, { opcode: OPCODE.text, fin: true, payload: Buffer.from("hello") });

  const medium = readServerFrame(encodeText("x".repeat(300)));
  assert.equal(medium.payload.length, 300);
  assert.equal(medium.payload.toString(), "x".repeat(300));

  const long = readServerFrame(encodeText("y".repeat(70000)));
  assert.equal(long.payload.length, 70000);

  // Multi-byte UTF-8 is measured in bytes, not characters.
  const utf8 = readServerFrame(encodeText("中文"));
  assert.equal(utf8.payload.length, 6);
});

test("encodes control frames (ping, pong, close with a code and reason)", () => {
  assert.equal(readServerFrame(encodePing(Buffer.alloc(0))).opcode, OPCODE.ping);
  assert.equal(readServerFrame(encodePong(Buffer.from("ka"))).opcode, OPCODE.pong);

  const close = readServerFrame(encodeClose(1008, "policy"));
  assert.equal(close.opcode, OPCODE.close);
  assert.equal(close.payload.readUInt16BE(0), 1008);
  assert.equal(close.payload.subarray(2).toString(), "policy");
});

test("a close reason longer than 123 bytes is truncated, not rejected", () => {
  const close = readServerFrame(encodeClose(1000, "z".repeat(400)));
  assert.equal(close.payload.length, 2 + 123);
});

test("parses a masked client frame and unmasks its payload", () => {
  const parser = createFrameParser();
  const frames = parser.push(clientFrame(OPCODE.text, "hello pi"));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, OPCODE.text);
  assert.equal(frames[0].payload.toString(), "hello pi");
  assert.equal(parser.pending, 0);
});

test("buffers a frame that arrives split across reads", () => {
  const parser = createFrameParser();
  const frame = clientFrame(OPCODE.text, "split-me");
  for (const byte of frame.subarray(0, frame.length - 1)) {
    assert.deepEqual(parser.push(Buffer.from([byte])), [], "no frame before its last byte");
  }
  const frames = parser.push(frame.subarray(frame.length - 1));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.toString(), "split-me");
});

test("returns every complete frame of a burst and keeps the partial tail", () => {
  const parser = createFrameParser();
  const burst = Buffer.concat([
    clientFrame(OPCODE.text, "one"),
    clientFrame(OPCODE.ping, "p"),
    clientFrame(OPCODE.close, ""),
    clientFrame(OPCODE.text, "half").subarray(0, 5),
  ]);
  const frames = parser.push(burst);
  assert.deepEqual(frames.map((frame) => frame.opcode), [OPCODE.text, OPCODE.ping, OPCODE.close]);
  assert.ok(parser.pending > 0);
});

test("a frame larger than the limit is refused instead of buffered", () => {
  const parser = createFrameParser({ maxPayload: 16 });
  const header = Buffer.from([0x81, 0x80 | 100]);
  assert.throws(() => parser.push(header), /exceeds the 16-byte limit/);
});

test("a server frame (unmasked) is read as-is", () => {
  const parser = createFrameParser();
  const frames = parser.push(encodeText("from another server"));
  assert.equal(frames[0].payload.toString(), "from another server");
});
