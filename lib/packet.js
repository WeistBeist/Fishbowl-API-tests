"use strict";

const { EventEmitter } = require("events");

function encodePacket(text) {
  const body = Buffer.from(String(text), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function readPacket(socket, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let settled = false;

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (err) reject(err);
      else resolve(value);
    }

    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (len > 32 * 1024 * 1024) {
        finish(new Error("Fishbowl response is too large."));
        return;
      }
      if (buf.length < 4 + len) return;
      finish(null, buf.subarray(4, 4 + len).toString("utf8"));
    }

    function onError(err) {
      finish(err);
    }

    function onClose() {
      finish(new Error("Fishbowl closed the connection."));
    }

    const timer = setTimeout(() => {
      finish(new Error("Timed out waiting for Fishbowl."));
    }, timeoutMs);

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

function createFakeSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.write = () => {};
  socket.destroy = () => {
    socket.destroyed = true;
    socket.emit("close");
  };
  return socket;
}

module.exports = {
  encodePacket,
  readPacket,
  createFakeSocket,
};
