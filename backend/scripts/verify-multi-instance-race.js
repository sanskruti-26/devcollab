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
//   BACKEND1_URL, BACKEND2_URL, JWT_SECRET

const jwt = require("jsonwebtoken");
const { io } = require("socket.io-client");
const Y = require("yjs");

const BACKEND1_URL = process.env.BACKEND1_URL || "http://localhost:5001";
const BACKEND2_URL = process.env.BACKEND2_URL || "http://localhost:5002";
// Matches the dev-only secret in docker-compose.yml — never reuse this value
// for anything real.
const JWT_SECRET = process.env.JWT_SECRET || "devcollab_docker_compose_dev_secret_do_not_use_in_prod";

const roomId = `race-test-room-${Date.now()}`;
const fileId = `race-test-file-${Date.now()}`;

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

function syncRequest(socket) {
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
  const socket1 = await connect(BACKEND1_URL, "userA");
  const socket2 = await connect(BACKEND2_URL, "userB");
  console.log(`Connected: ${BACKEND1_URL} (${socket1.id}) and ${BACKEND2_URL} (${socket2.id})`);

  socket1.emit("join-room", { roomId });
  socket2.emit("join-room", { roomId });
  await new Promise((r) => setTimeout(r, 300));

  // Both clients start from the same (empty) doc state.
  const initialState = await syncRequest(socket1);
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

  const final1 = await syncRequest(socket1);
  const final2 = await syncRequest(socket2);
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
