// load-test/script.js — realistic concurrent-usage load test for DevCollab.
//
// Talks RAW Engine.IO v4 / Socket.io v4 framing over k6/websockets — not a
// Socket.io client library, because k6 scripts run in goja (a pure-Go JS
// engine), not Node, so `socket.io-client` can't just be required here. The
// framing is hand-rolled but small and stable (verified empirically against
// this exact stack before writing this file):
//   "0{...}"        Engine.IO OPEN (server->client handshake, contains sid)
//   "2" / "3"       Engine.IO PING / PONG (server pings, client must pong
//                   within pingTimeout or the server drops the connection)
//   "40{...}"       Socket.io CONNECT, client->server carries {token} as the
//                   auth payload (this is what middleware/socketAuth.js
//                   reads as socket.handshake.auth.token); server->client
//                   echoes "40{sid}" on success or "44{...}" on auth failure
//   "42[...]"       Socket.io EVENT — plain JSON event, e.g.
//                   42["join-room",{"roomId":"..."}]
//   "45N-[...]"     Socket.io BINARY_EVENT header: N binary attachments will
//                   follow as separate raw WebSocket binary frames, in
//                   order. The JSON array contains {"_placeholder":true,
//                   "num":k} in place of each attachment. This is how
//                   yjs-update / yjs-sync-response carry their binary Yjs
//                   payload (see roomService.js).
//
// Sync-latency measurement: the server relays yjs-update's raw bytes
// unchanged (socket.to(roomId).emit("yjs-update", {fileId, update})) — no
// re-encoding happens. So instead of decoding real Yjs structure in k6, each
// outgoing "keystroke" is a pre-baked-valid Yjs update (see fixtures/) with a
// 32-byte marker patched in-place, containing the sender's VU id and send
// timestamp. A receiving VU reads that marker straight out of the relayed
// bytes and computes latency = now - embeddedSendTime. No cross-VU shared
// state needed (k6 VUs don't share JS memory) — the timestamp travels with
// the message itself.
//
// Reconnection-time measurement: a separate, smaller VU population
// periodically closes its socket mid-session and reconnects, timing from
// the close down to the first successful yjs-sync-response afterward — that
// (not just "the socket reopened") is the meaningful "usable again" point
// for a collaborative editor.

import { WebSocket } from "k6/websockets";
import { hmac } from "k6/crypto";
import { b64encode, b64decode } from "k6/encoding";
import { Trend, Counter } from "k6/metrics";
import { SharedArray } from "k6/data";

// ── Config (override with -e KEY=value) ─────────────────────────────────────

// Default targets nginx on the compose network by service name — see
// README.md for why (round-robin across backend1/backend2, the actual
// multi-instance scenario this is meant to exercise). Override with
// -e BASE_WS_URL=ws://localhost:8080 if running k6 natively on the host
// instead of via `docker run --network devcollab_default`.
const BASE_WS_URL = __ENV.BASE_WS_URL || "ws://nginx:80";
// Matches the dev-only secret in docker-compose.yml — never reuse this value
// for anything real.
const JWT_SECRET = __ENV.JWT_SECRET || "devcollab_docker_compose_dev_secret_do_not_use_in_prod";

const ROOMS = parseInt(__ENV.ROOMS || "20", 10);
const USERS_PER_ROOM = parseInt(__ENV.USERS_PER_ROOM || "5", 10);
const EDITOR_VUS = ROOMS * USERS_PER_ROOM;

const DURATION_S = parseInt(__ENV.DURATION_S || "120", 10);
// Staggered per-keystroke delay range — deliberately NOT synchronized across
// VUs (each VU also picks its own random initial delay before its first
// send), so edits arrive spread out over time rather than in lockstep
// bursts, matching how real typists behave relative to each other.
const TYPING_MIN_MS = parseInt(__ENV.TYPING_MIN_MS || "1000", 10);
const TYPING_MAX_MS = parseInt(__ENV.TYPING_MAX_MS || "3000", 10);

const RECONNECT_VUS = parseInt(__ENV.RECONNECT_VUS || "10", 10);
// How long a reconnect-churn VU stays connected before dropping again.
const RECONNECT_HOLD_MS = parseInt(__ENV.RECONNECT_HOLD_MS || "10000", 10);

// ── Fixtures ─────────────────────────────────────────────────────────────
// SharedArray loads+parses this JSON exactly once and shares the (read-only)
// result cheaply across every VU, instead of each VU re-reading/parsing its
// own copy — see fixtures/generate-yjs-fixtures.js for how/why this exists.
const fixtureData = new SharedArray("yjs-templates", function () {
  return [JSON.parse(open("./fixtures/yjs-update-templates.json"))];
})[0];
const MARKER_OFFSET = fixtureData.markerOffset;
const MARKER_LENGTH = fixtureData.markerLength;
const TEMPLATES = fixtureData.templates;

if (EDITOR_VUS > TEMPLATES.length) {
  throw new Error(
    `EDITOR_VUS (${EDITOR_VUS}) exceeds the fixture pool (${TEMPLATES.length} templates). ` +
      `Regenerate with a larger POOL_SIZE in fixtures/generate-yjs-fixtures.js first.`
  );
}

// ── Metrics ──────────────────────────────────────────────────────────────
const syncLatency = new Trend("sync_latency_ms", true);
const reconnectTime = new Trend("reconnect_time_ms", true);
const updatesSent = new Counter("yjs_updates_sent");
const updatesReceived = new Counter("yjs_updates_received");
const reconnectCycles = new Counter("reconnect_cycles");
const wsConnectErrors = new Counter("ws_connect_errors");
const wsAuthErrors = new Counter("ws_auth_errors");

// ── JWT (hand-rolled HS256 — no npm jsonwebtoken available in goja) ────────
function base64url(input) {
  return b64encode(input, "rawurl");
}

function mintToken(id) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ id, name: id, email: `${id}@loadtest.local` }));
  const signingInput = `${header}.${payload}`;
  const sig = hmac("sha256", JWT_SECRET, signingInput, "base64rawurl");
  return `${signingInput}.${sig}`;
}

// ── Yjs update marker embed/extract (see fixtures/generate-yjs-fixtures.js) ─
function pad(n, width) {
  return String(n).padStart(width, "0");
}

// Exactly MARKER_LENGTH (32) ASCII bytes: L + 6-digit VU + "-" + 6-digit seq
// + "-" + 13-digit epoch-ms + "-END". Same length in, same length out — the
// only thing that changes in the underlying Yjs update is which ASCII bytes
// occupy an already-length-prefixed text run, which is why patching in place
// can't invalidate the update's structure.
function buildMarker(vu, seq, ts) {
  return `L${pad(vu, 6)}-${pad(seq, 6)}-${pad(ts, 13)}-END`;
}

const MARKER_RE = /^L(\d{6})-(\d{6})-(\d{13})-END$/;

function parseMarker(arrayBuffer) {
  const view = new Uint8Array(arrayBuffer);
  if (view.length < MARKER_OFFSET + MARKER_LENGTH) return null;
  let s = "";
  for (let i = 0; i < MARKER_LENGTH; i++) s += String.fromCharCode(view[MARKER_OFFSET + i]);
  const m = MARKER_RE.exec(s);
  if (!m) return null;
  return { vu: parseInt(m[1], 10), seq: parseInt(m[2], 10), ts: parseInt(m[3], 10) };
}

// Builds this VU's next outgoing "keystroke": its own private template
// (stable clientID lineage for the whole test — see fixtures generator)
// with a fresh marker patched in at MARKER_OFFSET.
function buildUpdate(vu, seq) {
  const templateB64 = TEMPLATES[(vu - 1) % TEMPLATES.length];
  const bytes = new Uint8Array(b64decode(templateB64)); // fresh copy each call, safe to mutate
  const marker = buildMarker(vu, seq, Date.now());
  for (let i = 0; i < MARKER_LENGTH; i++) {
    bytes[MARKER_OFFSET + i] = marker.charCodeAt(i);
  }
  return bytes.buffer;
}

// ── Engine.IO / Socket.io connection helper ─────────────────────────────────
// Shared by both scenarios. Opens the socket, does the handshake + auth +
// join-room + yjs-sync-request dance, and dispatches parsed events to the
// caller's handlers. Binary attachments are reassembled before dispatch, so
// callers never see raw wire framing.
function openRoomConnection({ userId, roomId, fileId, onSyncResponse, onYjsUpdate, onConnectError }) {
  const token = mintToken(userId);
  const ws = new WebSocket(`${BASE_WS_URL}/socket.io/?EIO=4&transport=websocket`);
  ws.binaryType = "arraybuffer";

  let pendingBinary = null; // { name, jsonArgs, expected, received: [] }

  function sendEvent(name, payload) {
    ws.send(`42${JSON.stringify([name, payload])}`);
  }

  ws.onerror = (e) => {
    wsConnectErrors.add(1);
    if (__ENV.DEBUG) {
      console.log(`[ws.onerror] vu=${__VU} userId=${userId} error=${e && e.error}`);
    }
  };

  ws.onmessage = (event) => {
    const data = event.data;

    if (typeof data !== "string") {
      if (pendingBinary) {
        pendingBinary.received.push(data);
        if (pendingBinary.received.length >= pendingBinary.expected) {
          dispatch(pendingBinary.name, pendingBinary.jsonArgs, pendingBinary.received);
          pendingBinary = null;
        }
      }
      return;
    }

    if (data === "2") {
      ws.send("3"); // Engine.IO PING -> PONG, or the server drops us as dead
      return;
    }
    if (data.charAt(0) === "0") {
      ws.send(`40${JSON.stringify({ token })}`);
      return;
    }
    if (data.startsWith("44")) {
      wsAuthErrors.add(1);
      if (onConnectError) onConnectError(data.slice(2));
      return;
    }
    if (data.startsWith("40")) {
      sendEvent("join-room", { roomId });
      sendEvent("yjs-sync-request", { roomId, fileId });
      return;
    }
    const binHeader = /^45(\d+)-(.*)$/s.exec(data);
    if (binHeader) {
      const expected = parseInt(binHeader[1], 10);
      const arr = JSON.parse(binHeader[2]);
      pendingBinary = { name: arr[0], jsonArgs: arr[1], expected, received: [] };
      return;
    }
    if (data.startsWith("42")) {
      const arr = JSON.parse(data.slice(2));
      dispatch(arr[0], arr[1], []);
    }
    // anything else (bare "1" close, "6" noop, etc.) — nothing to do
  };

  function dispatch(name, jsonArgs, binaryAttachments) {
    if (name === "yjs-sync-response" && onSyncResponse) {
      onSyncResponse();
    } else if (name === "yjs-update" && onYjsUpdate) {
      onYjsUpdate(binaryAttachments[0], jsonArgs);
    }
  }

  return {
    ws,
    sendYjsUpdate(fileId, update) {
      ws.send(`451-${JSON.stringify(["yjs-update", { roomId, fileId, update: { _placeholder: true, num: 0 } }])}`);
      ws.send(update);
    },
    close() {
      try {
        ws.close();
      } catch (e) {
        // already closed — fine
      }
    },
  };
}

// ── Scenario: editors ────────────────────────────────────────────────────
// N virtual users split into ROOMS rooms of USERS_PER_ROOM each, all editing
// the same shared file per room, sending staggered "keystrokes" for the
// whole test and measuring how fast the OTHER users in their room see them.
export function editors() {
  const vu = __VU;
  // __VU is unique across the WHOLE test run, not a dense 1..EDITOR_VUS range
  // local to this scenario — reconnect_churn's VUs share the same global ID
  // pool and aren't guaranteed to be numbered after this scenario's, so
  // Math.floor((vu-1)/USERS_PER_ROOM) can (and did, in testing — vu=108
  // produced roomIndex=21 with ROOMS=20) land outside [0, ROOMS). Modulo is
  // robust to whatever the actual vu values turn out to be, at the cost of
  // room sizes only being APPROXIMATELY USERS_PER_ROOM (pigeonhole, not
  // guaranteed exact) rather than precisely even.
  const roomIndex = vu % ROOMS;
  const roomId = `loadtest-room-${roomIndex}`;
  const fileId = `loadtest-file-${roomIndex}`;
  const userId = `loadtest-editor-${vu}`;

  const endAt = Date.now() + DURATION_S * 1000;
  let seq = 0;
  let synced = false;

  const conn = openRoomConnection({
    userId,
    roomId,
    fileId,
    onSyncResponse: () => {
      // Only start "typing" once we've done the same initial sync a real
      // client does on file open — sending updates before that isn't
      // representative of real usage. The poll loop below is already
      // running by the time this fires; it just starts actually sending.
      synced = true;
    },
    onYjsUpdate: (updateBuf) => {
      updatesReceived.add(1);
      const marker = parseMarker(updateBuf);
      // socket.to(room) already excludes the sender, but double-check —
      // a self-received edit would corrupt the latency distribution.
      if (marker && marker.vu !== vu) {
        const latency = Date.now() - marker.ts;
        if (latency >= 0) syncLatency.add(latency);
      }
    },
  });

  // IMPORTANT: this first setTimeout call happens SYNCHRONOUSLY, before this
  // exported function returns. k6's per-vu-iterations executor considers the
  // iteration finished once the function body returns AND nothing is
  // keeping the event loop alive — an open WebSocket with only async
  // listeners registered doesn't count on its own. Scheduling here
  // (unconditionally, before the sync-response has even arrived) is what
  // keeps the VU alive for the test's full duration instead of the
  // iteration silently ending within milliseconds, which is what happened
  // when this call was nested inside the onSyncResponse callback instead.
  scheduleNextSend();

  function scheduleNextSend() {
    if (Date.now() >= endAt) {
      conn.close();
      return;
    }
    // Poll quickly until synced (cheap — just a timer, no network I/O), then
    // switch to the real staggered typing cadence once there's actually
    // something realistic to send.
    const delay = synced ? TYPING_MIN_MS + Math.random() * (TYPING_MAX_MS - TYPING_MIN_MS) : 200;
    setTimeout(() => {
      if (Date.now() >= endAt) {
        conn.close();
        return;
      }
      if (synced) {
        seq += 1;
        conn.sendYjsUpdate(fileId, buildUpdate(vu, seq));
        updatesSent.add(1);
      }
      scheduleNextSend();
    }, delay);
  }
}

// ── Scenario: reconnect_churn ────────────────────────────────────────────
// A smaller population that repeatedly: connects, syncs, holds the
// connection briefly (simulating active editing), then forcibly drops and
// reconnects — timing from the drop to the next successful resync.
export function reconnect_churn() {
  const vu = __VU;
  const userId = `loadtest-reconnect-${vu}`;
  // Each reconnect VU gets its own private room/file — this scenario is
  // about one user's OWN drop/resume timing, not cross-user sync, so there's
  // no need for room-mates here.
  const roomId = `loadtest-reconnect-room-${vu}`;
  const fileId = `loadtest-reconnect-file-${vu}`;
  const endAt = Date.now() + DURATION_S * 1000;

  let disconnectedAt = null;
  let syncedAt = null;
  let conn = null;

  function startConnection() {
    const isReconnect = disconnectedAt !== null;
    syncedAt = null;
    conn = openRoomConnection({
      userId,
      roomId,
      fileId,
      onSyncResponse: () => {
        syncedAt = Date.now();
        if (isReconnect) {
          reconnectTime.add(syncedAt - disconnectedAt);
          reconnectCycles.add(1);
        }
      },
    });
  }

  // Same reasoning as scheduleNextSend() in editors(): this first setTimeout
  // must be registered synchronously, before the function returns, or k6
  // tears the VU's connection down within milliseconds instead of running
  // it for the scenario's full duration.
  function tick() {
    if (Date.now() >= endAt) {
      if (conn) conn.close();
      return;
    }
    if (syncedAt !== null && Date.now() - syncedAt >= RECONNECT_HOLD_MS) {
      disconnectedAt = Date.now();
      conn.close();
      conn = null;
      setTimeout(() => {
        startConnection();
        setTimeout(tick, 200);
      }, 50); // brief pause before redialing, like a real client's reconnect backoff floor
      return;
    }
    setTimeout(tick, 200);
  }

  startConnection();
  tick();
}

// ── k6 options ───────────────────────────────────────────────────────────
export const options = {
  scenarios: {
    editors: {
      executor: "per-vu-iterations",
      exec: "editors",
      vus: EDITOR_VUS,
      iterations: 1,
      maxDuration: `${DURATION_S + 30}s`,
    },
    reconnect_churn: {
      executor: "per-vu-iterations",
      exec: "reconnect_churn",
      vus: RECONNECT_VUS,
      iterations: 1,
      maxDuration: `${DURATION_S + 30}s`,
    },
  },
  thresholds: {
    ws_connect_errors: ["count==0"],
    ws_auth_errors: ["count==0"],
  },
};
