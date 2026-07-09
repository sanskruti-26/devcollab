// tests/integration/helpers/testClient.js
//
// Shared connection helpers for the integration suite. These tests talk to
// the REAL backend1/backend2 containers from docker-compose.yml over actual
// Socket.io connections — same approach as scripts/verify-multi-instance-race.js,
// just wrapped in Jest assertions instead of a manual pass/fail script.

const jwt = require("jsonwebtoken");
const { io } = require("socket.io-client");
const Y = require("yjs");

// Matches the dev-only secret in docker-compose.yml — never reuse this value
// for anything real.
const JWT_SECRET = process.env.JWT_SECRET || "devcollab_docker_compose_dev_secret_do_not_use_in_prod";
// 127.0.0.1, not "localhost" — Node's fetch/driver stacks resolving
// "localhost" to ::1 first has been an intermittent source of spurious
// connection failures on this host; being explicit about IPv4 avoids it.
const BACKEND1_URL = process.env.BACKEND1_URL || "http://127.0.0.1:5001";
const BACKEND2_URL = process.env.BACKEND2_URL || "http://127.0.0.1:5002";

function mintToken(name) {
  return jwt.sign({ id: name, name, email: `${name}@test.local` }, JWT_SECRET);
}

function connect(url, name) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { auth: { token: mintToken(name) }, transports: ["websocket"] });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (err) => reject(new Error(`${url} connect_error: ${err.message}`)));
  });
}

// join-room has no ack — give the server a beat to process it before callers
// send anything that depends on room membership (chat/presence broadcasts).
function joinRoom(socket, roomId) {
  return new Promise((resolve) => {
    socket.emit("join-room", { roomId });
    setTimeout(resolve, 150);
  });
}

function syncRequest(socket, roomId, fileId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("yjs-sync-response timeout")), 8000);
    socket.once("yjs-sync-response", ({ state }) => {
      clearTimeout(timer);
      resolve(state);
    });
    socket.emit("yjs-sync-request", { roomId, fileId });
  });
}

function sendUpdate(socket, roomId, fileId, update) {
  socket.emit("yjs-update", { roomId, fileId, update: Buffer.from(update) });
}

function newDocFrom(state) {
  const doc = new Y.Doc();
  if (state?.length) Y.applyUpdate(doc, new Uint8Array(state));
  return doc;
}

function textOf(doc) {
  return doc.getText("content").toString();
}

function uniqueId(label) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  BACKEND1_URL,
  BACKEND2_URL,
  mintToken,
  connect,
  joinRoom,
  syncRequest,
  sendUpdate,
  newDocFrom,
  textOf,
  uniqueId,
  wait,
};
