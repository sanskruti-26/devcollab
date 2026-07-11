// scripts/verify-multi-instance-race.js
//
// Manual/scripted check for the Redis pub/sub fix in services/roomService.js:
// two simulated clients, connected to two DIFFERENT backend instances, send
// edits to the same file within milliseconds of each other — not one after
// the other with a pause, which would never exercise the race at all. Before
// the fix (each instance overwriting a single shared "latest state" key in
// Redis), whichever instance's write landed last would silently discard the
// other instance's edit. After the fix (diffs broadcast over Redis pub/sub,
// merged independently by every instance), both edits must survive and both
// instances must converge to identical content.
//
// Requires the multi-instance rig from docker-compose.yml running:
//   docker compose up --build mongo redis backend1 backend2
// Then:
//   npm run verify:multi-instance
//
// Env overrides (defaults match docker-compose.yml):
//   BACKEND1_URL, BACKEND2_URL

const { io } = require("socket.io-client");
const Y = require("yjs");

const BACKEND1_URL = process.env.BACKEND1_URL || "http://localhost:5001";
const BACKEND2_URL = process.env.BACKEND2_URL || "http://localhost:5002";

// join-room does a real DB-backed owner-or-participant check (see
// authorizeRoomJoin in roomService.js) — a hand-minted JWT for a made-up
// roomId that was never actually created via the REST API fails it every
// time. This registers two real users and a real room/file through the
// same REST routes the frontend uses, so both sockets carry genuine access:
// userA creates the room (becomes owner), userB does the same GET /:roomId
// the frontend does on join, which adds them as a participant.
async function registerUser(name) {
  const email = `${name}-${Date.now()}@test.local`;
  const res = await fetch(`${BACKEND1_URL}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password: "racetest123" }),
  }).then((r) => r.json());
  if (!res.token) throw new Error(`registerUser(${name}) failed: ${JSON.stringify(res)}`);
  return res.token;
}

async function setupRoomAndFile() {
  const tokenA = await registerUser("userA");
  const tokenB = await registerUser("userB");

  const room = await fetch(`${BACKEND1_URL}/api/v1/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ name: `race-test-room-${Date.now()}`, language: "javascript" }),
  }).then((r) => r.json());
  if (!room.roomId) throw new Error(`Room creation failed: ${JSON.stringify(room)}`);

  // Same GET the frontend fires on join — adds userB to room.participants.
  await fetch(`${BACKEND1_URL}/api/v1/rooms/${room.roomId}`, {
    headers: { Authorization: `Bearer ${tokenB}` },
  }).then((r) => r.json());

  const files = await fetch(`${BACKEND1_URL}/api/v1/rooms/${room.roomId}/files`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  }).then((r) => r.json());
  if (!files[0]?._id) throw new Error(`File lookup failed: ${JSON.stringify(files)}`);

  return { tokenA, tokenB, roomId: room.roomId, fileId: files[0]._id };
}

function connect(url, token) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { auth: { token }, transports: ["websocket"] });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (err) => reject(new Error(`${url} connect_error: ${err.message}`)));
  });
}

// Mirrors the real frontend's roomJoinedRef gating (see RoomPage.jsx): wait
// for the server's explicit "room-joined" ack — sent only after join-room's
// DB-backed authorization check resolves — instead of a fixed sleep guessing
// how long that check takes. A fixed delay was a symptom of the same race
// class that used to cause the empty-editor-on-refresh bug: yjs-sync-request
// arriving before join-room's authorization landed got silently dropped by
// requireRoomAccess. Waiting on the real ack is exact instead of hopeful.
function joinRoom(socket, roomId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("room-joined ack timeout")), 5000);
    socket.once("room-joined", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("room-access-denied", (payload) => {
      clearTimeout(timer);
      reject(new Error(`room-access-denied: ${JSON.stringify(payload)}`));
    });
    socket.emit("join-room", { roomId });
  });
}

function syncRequest(socket, roomId, fileId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("yjs-sync-response timeout")), 5000);
    socket.once("yjs-sync-response", ({ state }) => {
      clearTimeout(timer);
      resolve(state);
    });
    socket.emit("yjs-sync-request", { roomId, fileId });
  });
}

function decodeText(state) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(state));
  return doc.getText("content").toString();
}

async function main() {
  const { tokenA, tokenB, roomId, fileId } = await setupRoomAndFile();
  console.log(`Created room ${roomId} (file ${fileId}) via REST — userA owns it, userB is a participant`);

  const socket1 = await connect(BACKEND1_URL, tokenA);
  const socket2 = await connect(BACKEND2_URL, tokenB);
  console.log(`Connected: ${BACKEND1_URL} (${socket1.id}) and ${BACKEND2_URL} (${socket2.id})`);

  await Promise.all([joinRoom(socket1, roomId), joinRoom(socket2, roomId)]);

  // Both clients start from the same (empty) doc state.
  const initialState = await syncRequest(socket1, roomId, fileId);
  const doc1 = new Y.Doc();
  Y.applyUpdate(doc1, new Uint8Array(initialState));
  const doc2 = new Y.Doc();
  Y.applyUpdate(doc2, new Uint8Array(initialState));

  let update1, update2;
  doc1.on("update", (u) => { update1 = u; });
  doc2.on("update", (u) => { update2 = u; });
  doc1.getText("content").insert(0, "HELLO-FROM-A");
  doc2.getText("content").insert(0, "HELLO-FROM-B");

  // The two emits below are NOT awaited between each other — that's the
  // point. A sequential await socket1...; await socket2... would let each
  // edit fully land (including its Redis write) before the next one starts,
  // which never exercises the race this script exists to catch.
  console.log("Firing both edits within milliseconds of each other...");
  socket1.emit("yjs-update", { roomId, fileId, update: Buffer.from(update1) });
  socket2.emit("yjs-update", { roomId, fileId, update: Buffer.from(update2) });

  await new Promise((r) => setTimeout(r, 1500)); // let Redis pub/sub propagate

  const final1 = await syncRequest(socket1, roomId, fileId);
  const final2 = await syncRequest(socket2, roomId, fileId);
  const text1 = decodeText(final1);
  const text2 = decodeText(final2);

  console.log(`${BACKEND1_URL} final content:`, JSON.stringify(text1));
  console.log(`${BACKEND2_URL} final content:`, JSON.stringify(text2));

  socket1.close();
  socket2.close();

  const bothHaveA = text1.includes("HELLO-FROM-A") && text2.includes("HELLO-FROM-A");
  const bothHaveB = text1.includes("HELLO-FROM-B") && text2.includes("HELLO-FROM-B");
  const converged = text1 === text2;

  if (bothHaveA && bothHaveB && converged) {
    console.log("PASS — both concurrent edits survived and both instances converged.");
    process.exit(0);
  }
  console.error("FAIL — an edit was lost or the two instances diverged.");
  console.error({ bothHaveA, bothHaveB, converged });
  process.exit(1);
}

main().catch((err) => {
  console.error("Script error:", err);
  process.exit(1);
});
