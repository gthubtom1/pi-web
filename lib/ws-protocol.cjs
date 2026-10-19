"use strict";

/**
 * The little of RFC 6455 a Pi Web live connection needs, in CommonJS so the
 * launcher (bin/pi-web-server.js, plain Node) shares it with the tests.
 *
 * The server only *pushes* one kind of thing: a text frame per agent event, the
 * exact `data:` payload of the SSE stream. It still has to speak enough of the
 * protocol to answer pings, read the client's close frame, and unmask anything
 * the browser sends (a browser masks every frame it sends).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require("node:crypto");

const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
};

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The `Sec-WebSocket-Accept` value for a handshake key. */
function acceptKey(secWebSocketKey) {
  return crypto.createHash("sha1").update(`${String(secWebSocketKey).trim()}${WS_GUID}`, "utf8").digest("base64");
}

/** One server-to-client frame (never masked, as the RFC requires of a server). */
function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? "", "utf8");
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[1] = body.length;
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    // 64-bit length; the high word is 0 for anything a transcript holds.
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(body.length, 6);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, body]);
}

const encodeText = (text) => encodeFrame(OPCODE.text, text);
const encodePong = (payload) => encodeFrame(OPCODE.pong, payload ?? Buffer.alloc(0));
const encodePing = (payload) => encodeFrame(OPCODE.ping, payload ?? Buffer.alloc(0));

function encodeClose(code = 1000, reason = "") {
  const text = Buffer.from(String(reason), "utf8").subarray(0, 123);
  const body = Buffer.alloc(2 + text.length);
  body.writeUInt16BE(code, 0);
  text.copy(body, 2);
  return encodeFrame(OPCODE.close, body);
}

/**
 * Incremental parser: feed it whatever arrived, get back complete frames. A
 * frame split across TCP segments is buffered until the rest is there, and
 * anything after the last complete frame stays in `rest` for the next call.
 */
function createFrameParser(options = {}) {
  const maxPayload = options.maxPayload ?? 1 << 20;
  let buffer = Buffer.alloc(0);

  return {
    push(chunk) {
      if (chunk && chunk.length) buffer = Buffer.concat([buffer, chunk]);
      const frames = [];
      let offset = 0;
      while (true) {
        const available = buffer.length - offset;
        if (available < 2) break;
        const first = buffer[offset];
        const second = buffer[offset + 1];
        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let cursor = offset + 2;
        if (length === 126) {
          if (buffer.length - cursor < 2) break;
          length = buffer.readUInt16BE(cursor);
          cursor += 2;
        } else if (length === 127) {
          if (buffer.length - cursor < 8) break;
          const high = buffer.readUInt32BE(cursor);
          const low = buffer.readUInt32BE(cursor + 4);
          length = high * 0x100000000 + low;
          cursor += 8;
        }
        if (length > maxPayload) {
          throw new Error(`WebSocket frame of ${length} bytes exceeds the ${maxPayload}-byte limit`);
        }
        let mask = null;
        if (masked) {
          if (buffer.length - cursor < 4) break;
          mask = buffer.subarray(cursor, cursor + 4);
          cursor += 4;
        }
        if (buffer.length - cursor < length) break;
        let payload = Buffer.from(buffer.subarray(cursor, cursor + length));
        cursor += length;
        if (mask) {
          for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
        }
        frames.push({ fin, opcode, payload });
        offset = cursor;
      }
      buffer = offset > 0 ? Buffer.from(buffer.subarray(offset)) : buffer;
      return frames;
    },
    /** Bytes held back because they do not form a complete frame yet. */
    get pending() {
      return buffer.length;
    },
  };
}

module.exports = {
  OPCODE,
  acceptKey,
  encodeFrame,
  encodeText,
  encodePing,
  encodePong,
  encodeClose,
  createFrameParser,
};
