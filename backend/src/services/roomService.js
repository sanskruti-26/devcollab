// services/roomService.js — Socket.io real-time logic
//
// Sync model:
// 1. User opens /room/:roomId → frontend connects + emits "join-room"
// 2. User opens a file → frontend emits "yjs-sync-request" { fileId }
// 3. Server responds with "yjs-sync-response" { fileId, state } — full Y.Doc binary state
// 4. As user types, Yjs fires doc.on('update') → frontend emits "yjs-update" { fileId, update }
// 5. Server applies update to server-side Y.Doc, broadcasts to room, schedules DB save + snapshot
//
// All legacy events (code-change, code-update, init-code, init-file, join-file) have been
// removed — any client still sending them is too old to join correctly and should hard-refresh.
//
// State ownership (multi-instance): the per-instance `ydocs` Map below is a
// LOCAL computation cache, not a shared source of truth — Yjs needs a live
// Y.Doc object to merge updates against, but each instance behind the load
// balancer has its own. Three things keep every instance's copy converged:
//   - Redis pub/sub channel `yjs:updates:{fileId}` — every yjs-update is
//     re-published here as its raw diff (not the full doc state) right after
//     being merged locally. Every instance that has the file open subscribes
//     to this channel and applies incoming diffs to its own local Y.Doc via
//     Y.applyUpdate. Because Yjs updates are commutative (merge order doesn't
//     change the converged result) and idempotent (re-applying an update
//     already merged is a safe no-op), this is enough for every instance's
//     doc to converge to the same content regardless of which instance
//     handled which keystroke — unlike overwriting a single shared "latest
//     state" value, which would silently drop whichever edit lost the race.
//   - Redis stream `yjs:updates:{fileId}` (same name as the pub/sub channel —
//     Redis's pub/sub namespace and keyspace are independent, so this is
//     safe) — every publish is ALSO XADD'd here, trimmed to the most recent
//     STREAM_MAXLEN entries. Pub/sub alone has a gap: SUBSCRIBE is an async
//     round trip, so an instance that's cold-starting a file can lose a race
//     against a PUBLISH from another, already-warm instance and miss that
//     diff forever (no backlog). Right after subscribing, a cold-starting
//     instance also reads this stream's entire (bounded) backlog and applies
//     every entry — since applyUpdate is idempotent, it's safe even for
//     entries also delivered live via pub/sub, and it guarantees nothing
//     published around cold-start time is lost regardless of which side of
//     the SUBSCRIBE-vs-PUBLISH race actually won.
//   - Redis key `yjs:state:{fileId}` — a full encoded snapshot, refreshed on
//     the same 5s debounce as the MongoDB save (see scheduleFileSave). This
//     is the cheap baseline for cold-start hydration, covering everything
//     older than the trimmed stream above can reach. MongoDB remains the
//     durable, restart-survivable copy, same as before.
//
// Session replay: snapshots full content strings read from Y.Doc after each merged write.

const Y      = require("yjs");
const { createClient, commandOptions } = require("redis");
const Room   = require("../models/Room");
const File   = require("../models/File");
const Message  = require("../models/Message");
const Snapshot = require("../models/Snapshot");
const Comment  = require("../models/Comment");
const socketAuthMiddleware = require("../middleware/socketAuth");
const { yjsUpdatesTotal } = require("../metrics");

// Redis is optional here, same convention as attachRedisAdapter() in
// server.js: only connects when REDIS_URL is set (multi-instance deployments,
// or docker-compose). Without it every helper below is a no-op and this file
// behaves exactly as it did before Redis was introduced — a single local
// Y.Doc per file, Mongo-backed — so plain `npm run dev` doesn't need Redis
// running and doesn't spam reconnect-error logs for a feature it's not using.
const REDIS_URL = process.env.REDIS_URL;

// Regular client: GET/SET the cold-start snapshot key, PUBLISH diffs.
const redisClient = REDIS_URL ? createClient({ url: REDIS_URL }) : null;
if (redisClient) {
  redisClient.on("error", (err) => console.error("Redis client error (roomService):", err.message));
  redisClient.connect().catch((err) => console.error("Redis connect error (roomService):", err.message));
}

// Separate dedicated connection for SUBSCRIBE: once a node-redis client
// subscribes to a channel it can only be used for subscribe/unsubscribe, so
// it can't share a connection with the GET/SET/PUBLISH calls above (this is
// the same pub/sub-client-vs-command-client split the socket.io-redis-adapter
// itself uses).
const redisSubscriber = redisClient ? redisClient.duplicate() : null;
if (redisSubscriber) {
  redisSubscriber.on("error", (err) => console.error("Redis subscriber error (roomService):", err.message));
  redisSubscriber.connect().catch((err) => console.error("Redis subscriber connect error (roomService):", err.message));
}

function redisSnapshotKey(fileId) {
  return `yjs:state:${fileId}`;
}

// Names BOTH the pub/sub channel and the Redis Stream key for a file's
// updates — see the state-ownership comment above for why one name safely
// serves double duty here.
function redisUpdatesKey(fileId) {
  return `yjs:updates:${fileId}`;
}

// Field name for the diff bytes within each stream entry.
const STREAM_UPDATE_FIELD = "update";
// Bounds each file's replay buffer — it only needs to cover "however long a
// cold start can take", not the file's whole edit history (Mongo/the
// snapshot key already own that).
const STREAM_MAXLEN = 1000;

// Reads the cold-start snapshot for a file back out as a Buffer — this is
// opaque binary CRDT data, not text, so it must round-trip with bufferMode.
async function getRedisSnapshot(fileId) {
  if (!redisClient) return null;
  return redisClient.get(commandOptions({ returnBuffers: true }), redisSnapshotKey(fileId));
}

// Overwrites the cold-start snapshot with the doc's current full state. Only
// called from the 5s debounce in scheduleFileSave and from first-hydration —
// NEVER from the per-keystroke yjs-update path, since two instances racing
// to SET this key is exactly the overwrite bug this design avoids.
async function writeRedisSnapshot(fileId, encodedState) {
  if (!redisClient) return;
  try {
    await redisClient.set(redisSnapshotKey(fileId), Buffer.from(encodedState));
  } catch (err) {
    console.error(`writeRedisSnapshot error for ${fileId}:`, err.message);
  }
}

// Broadcasts one merged update's diff to every other instance — live, via
// Redis pub/sub, AND durably (bounded), via a Redis Stream, so a
// cold-starting instance can catch up on it even if it loses the timing race
// against the pub/sub side (see subscribeToFileUpdates / catchUpFromStream).
async function publishUpdateDiff(fileId, update) {
  if (!redisClient) return;
  const key = redisUpdatesKey(fileId);
  try {
    await Promise.all([
      redisClient.publish(key, Buffer.from(update)),
      redisClient.xAdd(key, "*", { [STREAM_UPDATE_FIELD]: Buffer.from(update) }, {
        TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: STREAM_MAXLEN },
      }),
    ]);
  } catch (err) {
    console.error(`publishUpdateDiff error for ${fileId}:`, err.message);
  }
}

// Subscribes this instance to another file's update channel so its local
// Y.Doc stays converged with every other instance's edits. Called once per
// fileId per instance, from getOrCreateYDoc's cold-start path.
//
// We do NOT tag messages with an instance id to filter out our own — an
// instance that published a diff will also receive it back here (Redis
// pub/sub delivers to every subscriber, publisher included). Re-applying it
// is a safe no-op (Yjs dedupes by item id/clock), so filtering would only
// save one cheap no-op merge per keystroke, at the cost of a second
// correctness mechanism layered on top of the idempotency we already have to
// rely on anyway (pub/sub gives no ordering/delivery guarantees across
// instances, so convergence always depends on Yjs's commutativity, tagging
// or not).
async function subscribeToFileUpdates(fileId) {
  if (!redisSubscriber) return;
  try {
    await redisSubscriber.subscribe(
      redisUpdatesKey(fileId),
      (message) => {
        const ydoc = ydocs.get(fileId);
        if (ydoc) Y.applyUpdate(ydoc, message, "redis-pubsub");
      },
      true // bufferMode: deliver the raw binary diff, not a decoded string
    );
  } catch (err) {
    console.error(`subscribeToFileUpdates error for ${fileId}:`, err.message);
  }
}

// Reads this file's entire (bounded) replay buffer and applies every entry.
// Called once per fileId per instance, right after subscribeToFileUpdates,
// from getOrCreateYDoc's cold-start path. This is what actually closes the
// SUBSCRIBE-vs-PUBLISH race: SUBSCRIBE is an async round trip, so a diff
// published by another (already-warm) instance can reach Redis before our
// subscription is registered there, and pub/sub has no backlog to deliver it
// late. The stream does — whatever the live subscription missed, this read
// still finds, and re-applying entries the subscription DID catch is a safe
// no-op (Y.applyUpdate is idempotent).
async function catchUpFromStream(fileId, ydoc) {
  if (!redisClient) return;
  try {
    const entries = await redisClient.xRange(
      commandOptions({ returnBuffers: true }),
      redisUpdatesKey(fileId),
      "-",
      "+"
    );
    for (const entry of entries) {
      const bytes = entry.message[STREAM_UPDATE_FIELD];
      if (bytes?.length) Y.applyUpdate(ydoc, bytes, "redis-stream");
    }
  } catch (err) {
    console.error(`catchUpFromStream error for ${fileId}:`, err.message);
  }
}

// ── In-memory caches ──────────────────────────────────────────────────────────

// Server-side Y.Doc per file — a LOCAL cache, not the source of truth. Kept
// converged with other instances via the Redis pub/sub channel above.
// Bootstrapped from the Redis snapshot (falling back to MongoDB) on first
// access on this instance. Map<fileId (string), Y.Doc>
const ydocs = new Map();

// Creation locks — Map<fileId, Promise<Y.Doc>>.
// Prevents the race where two concurrent getOrCreateYDoc calls (both seeing
// ydocs.has = false before either resolves) each create a separate Y.Doc with a
// different clientID. If clients receive sync responses from different docs their
// edits reference incompatible item IDs, so Yjs can never merge them and characters
// silently disappear. Storing the promise immediately means every concurrent caller
// awaits the same creation+hydration work and gets back the exact same Y.Doc instance.
const ydocLocks = new Map();

// Debounce timers for per-file DB saves: fileId → setTimeout handle
const fileSaveTimers = new Map();

// Debounce timers for snapshots — keyed by fileId when available, else roomId.
const snapshotTimers = new Map();

// Debounce timers for comment-anchor reconciliation — keyed by fileId.
const commentReconcileTimers = new Map();

// Throttle state for broadcastFilePresence, keyed by roomId — see that
// function for how it's used.
const presenceThrottle = new Map();
const PRESENCE_THROTTLE_MS = 300;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Returns the server-side Y.Doc for a file, LOCAL to this instance.
// Hot path (doc already created on this instance): synchronous map lookup,
// no await cost — kept current in the background by the Redis pub/sub
// subscription set up below, not by re-fetching anything here.
// Cold path (first access on this instance): creates exactly ONE Y.Doc,
// registers it and subscribes to this file's update channel FIRST, THEN
// hydrates it from the Redis snapshot (falling back to MongoDB if Redis has
// nothing cached yet). That order matters: if we hydrated before subscribing,
// any diff another instance published in the gap between "we read the
// snapshot" and "we started listening" would be lost forever — pub/sub has
// no backlog, a message published before you subscribe never arrives late.
// Subscribing first means every diff from that point on lands on the same
// doc object hydration is about to mutate; Y.applyUpdate is commutative, so
// it doesn't matter whether a concurrent diff is applied before or after the
// snapshot replay. Any concurrent cold calls share the same creation promise
// so they all await the same hydrated doc — preventing the duplicate-clientID
// bug.
async function getOrCreateYDoc(fileId) {
  if (ydocs.has(fileId)) return ydocs.get(fileId);
  if (ydocLocks.has(fileId)) return ydocLocks.get(fileId);

  const promise = (async () => {
    const ydoc = new Y.Doc();
    ydocs.set(fileId, ydoc);
    await subscribeToFileUpdates(fileId);
    // Closes the SUBSCRIBE-vs-PUBLISH race described above — must run after
    // subscribing (so live delivery is also active) but works regardless of
    // which one actually wins the race, since applyUpdate is idempotent.
    await catchUpFromStream(fileId, ydoc);
    try {
      const cached = await getRedisSnapshot(fileId);
      if (cached?.length) {
        // Preferred path: another instance (or this one, before a restart)
        // already refreshed the snapshot — trust it over Mongo, which only
        // catches up every 5s via scheduleFileSave.
        Y.applyUpdate(ydoc, cached, "hydrate");
      } else {
        const file = await File.findById(fileId);
        if (file?.yjsState?.length) {
          // Preferred DB path: replay the actual CRDT state, so item identities
          // (and therefore existing comment relative-position anchors) survive
          // a restart.
          Y.applyUpdate(ydoc, file.yjsState, "hydrate");
        } else if (file?.content) {
          // Back-compat fallback for files saved before yjsState existed — seeds
          // readable text but with brand-new item identities. Any relative position
          // anchored against the old (lost) doc state can never resolve against
          // this one; see the migration note in models/File.js.
          ydoc.getText("content").insert(0, file.content);
        }
        // Seed the snapshot so the next cold start (this instance restarting,
        // or another instance opening the file) doesn't have to hit Mongo.
        if (file) await writeRedisSnapshot(fileId, Y.encodeStateAsUpdate(ydoc));
      }
    } catch (err) {
      console.error(`getOrCreateYDoc hydration error for ${fileId}:`, err.message);
    }
    ydocLocks.delete(fileId);
    return ydoc;
  })();

  ydocLocks.set(fileId, promise);
  return promise;
}

// Emit the current file-presence state to everyone in a room so they can show
// "who is viewing which file" indicators in the sidebar.
//
// Throttled per room, leading + trailing (like lodash's throttle): join-room,
// active-file-change, and yjs-sync-request all call this, and under a
// connection burst many of those fire within milliseconds of each other for
// the same room — each call doing its own cross-instance fetchSockets() is
// what drove fetchSockets timeouts at 500 concurrent editors (see
// load-test/README.md, tier 2). A lone call in an otherwise-quiet room still
// fires immediately (leading edge), so a single join still updates everyone
// right away. Calls that land inside the PRESENCE_THROTTLE_MS window don't
// trigger their own fetchSockets — they just set a flag so exactly one more
// broadcast fires right after the window closes (trailing edge), capturing
// whatever the latest state was by then. Net effect: at most one
// fetchSockets() per room per window, no matter how many of the three events
// fired inside it.
function broadcastFilePresence(io, roomId) {
  const state = presenceThrottle.get(roomId);

  if (!state) {
    presenceThrottle.set(roomId, { timer: schedulePresenceCooldown(io, roomId), callPending: false });
    return runPresenceBroadcast(io, roomId);
  }

  state.callPending = true;
  return Promise.resolve();
}

function schedulePresenceCooldown(io, roomId) {
  return setTimeout(() => {
    const state = presenceThrottle.get(roomId);
    presenceThrottle.delete(roomId);
    if (state && state.callPending) {
      broadcastFilePresence(io, roomId); // trailing call: re-opens a fresh window
    }
  }, PRESENCE_THROTTLE_MS);
}

async function runPresenceBroadcast(io, roomId) {
  try {
    const sockets = await io.in(roomId).fetchSockets();
    const presence = sockets.map((s) => ({
      socketId:     s.id,
      userName:     s.userName || "Anonymous",
      activeFileId: s.activeFileId || null,
    }));
    io.to(roomId).emit("file-presence-update", presence);
  } catch (err) {
    console.error("broadcastFilePresence error:", err.message);
  }
}

// Debounced save of a single File document (5 s). Persists both the readable
// plaintext (for the file tree, downloads, snapshots) and the encoded Yjs state
// (for rehydrating the CRDT itself on the next cold start — see getOrCreateYDoc).
// Also refreshes the Redis cold-start snapshot on this same debounce — NOT on
// every yjs-update, since two instances racing to overwrite that key per
// keystroke is exactly the race the pub/sub channel above exists to avoid.
function scheduleFileSave(fileId, content, yjsState, language, roomId) {
  if (fileSaveTimers.has(fileId)) clearTimeout(fileSaveTimers.get(fileId));
  fileSaveTimers.set(
    fileId,
    setTimeout(async () => {
      try {
        const update = { content, yjsState: Buffer.from(yjsState), $inc: { version: 1 } };
        if (language) update.language = language;
        await File.findByIdAndUpdate(fileId, update);
        console.log(`Auto-saved file ${fileId} (room ${roomId})`);
      } catch (err) {
        console.error("File auto-save error:", err.message);
      }
      await writeRedisSnapshot(fileId, yjsState);
    }, 5000)
  );
}

// Debounced snapshot for session replay (2 s throttle). Stores full content string
// so the existing replay UI (which steps through plain text snapshots) is unchanged.
function scheduleSnapshot(roomId, fileId, content, userName) {
  const key = fileId || roomId;
  if (snapshotTimers.has(key)) clearTimeout(snapshotTimers.get(key));
  snapshotTimers.set(
    key,
    setTimeout(async () => {
      try {
        await Snapshot.create({
          roomId,
          fileId: fileId || null,
          content,
          userName,
        });
      } catch (err) {
        console.error("Snapshot error:", err.message);
      }
    }, 2000)
  );
}

// ── Comment anchor reconciliation ─────────────────────────────────────────────
// Keeps comments tied to their code as the document is edited, using Yjs relative
// positions. Triggered (debounced) from every yjs-update. Only root comments with
// a relativePos participate — replies and pre-feature comments are untouched.

function decodeRelPos(base64Str) {
  return new Uint8Array(Buffer.from(base64Str, "base64"));
}

// 1-based line number containing character `index` of `text`.
function indexToLineNumber(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

async function reconcileComments(io, roomId, fileId) {
  try {
    const comments = await Comment.find({ fileId, parentId: null, relativePos: { $ne: null } });
    if (comments.length === 0) return;

    const ydoc = await getOrCreateYDoc(fileId);
    const text = ydoc.getText("content").toString();

    const deletedIds = [];

    for (const comment of comments) {
      let relPos;
      try {
        relPos = Y.decodeRelativePosition(decodeRelPos(comment.relativePos));
      } catch {
        continue; // corrupt/unreadable anchor — leave alone rather than guess
      }

      // IMPORTANT: createAbsolutePositionFromRelativePosition deliberately stays
      // resolvable through deletions (it returns the tombstone's position, by
      // design — e.g. so a cursor doesn't vanish when someone else deletes the
      // character it's on). It does NOT return null just because the anchored
      // text was deleted, so it can't be used as the deletion signal on its own
      // (verified directly against the installed yjs version before relying on
      // this). Instead, our anchor (created with the default, item-level assoc)
      // references a specific character's item id — ask Yjs directly whether
      // THAT item was deleted via Y.getItem(...).deleted, which is unambiguous.
      if (!relPos.item) continue; // type-relative anchor, no specific item — leave alone

      if (Y.getState(ydoc.store, relPos.item.client) <= relPos.item.clock) {
        continue; // this doc hasn't integrated the update that created the anchor yet
      }

      let item;
      try {
        item = Y.getItem(ydoc.store, relPos.item);
      } catch {
        continue; // unresolvable — leave alone rather than guess
      }

      if (item.deleted) {
        // The anchored text itself was deleted — the comment goes with it.
        deletedIds.push(comment._id);
        const replies = await Comment.find({ parentId: comment._id }).select("_id");
        deletedIds.push(...replies.map((r) => r._id));
        continue;
      }

      // Anchor's character is still alive — text just shifted (edits elsewhere,
      // e.g. lines inserted/deleted above it). Update the stored line if it moved.
      const abs = Y.createAbsolutePositionFromRelativePosition(relPos, ydoc);
      if (abs === null) continue; // shouldn't happen given the alive check above — stay safe

      const newLine = indexToLineNumber(text, abs.index);
      if (newLine !== comment.lineNumber) {
        comment.lineNumber = newLine;
        await comment.save();
        io.to(roomId).emit("comment-relocated", { commentId: comment._id, lineNumber: newLine });
      }
    }

    if (deletedIds.length > 0) {
      await Comment.deleteMany({ _id: { $in: deletedIds } });
      io.to(roomId).emit("comment-deleted", { fileId, commentIds: deletedIds });
    }
  } catch (err) {
    console.error("reconcileComments error:", err.message);
  }
}

// Debounced (1.5s) so a burst of keystrokes triggers one reconcile pass, not one per character.
function scheduleCommentReconcile(io, roomId, fileId) {
  if (commentReconcileTimers.has(fileId)) clearTimeout(commentReconcileTimers.get(fileId));
  commentReconcileTimers.set(
    fileId,
    setTimeout(() => reconcileComments(io, roomId, fileId), 1500)
  );
}

// ── Room-membership authorization ─────────────────────────────────────────────
// Mirrors hasRoomAccess() in routes/rooms.js — duplicated rather than imported
// to avoid a circular require (routes/rooms.js already imports
// broadcastCommentEvent from this file).
function hasRoomAccess(room, userId) {
  return (
    room.owner.toString() === userId ||
    room.participants.some((p) => p.toString() === userId)
  );
}

// One DB round trip, made once at join-room time. Password-protected rooms
// are covered implicitly: the only way to become a `participant` is the REST
// flow verifying the password first (routes/rooms.js's GET /:roomId), so
// "already a participant" already means "password already checked" — no
// need to re-verify bcrypt here.
async function authorizeRoomJoin(socket, roomId) {
  if (!roomId) return false;
  const room = await Room.findOne({ roomId });
  if (!room) return false;
  return hasRoomAccess(room, socket.user.id);
}

// Cheap, in-memory re-check used by every other room-scoped handler below —
// no DB access, just "did this socket already pass the join-room check for
// this exact roomId." A per-event DB hit here would reintroduce the same
// kind of cost that made fetchSockets() buckle at scale (see
// load-test/README.md) — yjs-update/cursor-move fire far too often for that.
// Rejects the offending event rather than disconnecting the whole socket —
// a stale/racy roomId on one bad event shouldn't kill an otherwise-valid
// connection that may be correctly joined to a different room.
//
// This used to fail completely silently: a client-invisible no-op, with only
// a console.warn on the server. That's how the empty-editor-on-refresh bug
// stayed invisible — yjs-sync-request arriving before join-room's DB check
// resolved was rejected here with nothing telling the client it happened.
// The real fix is the client no longer racing this check (it now waits for
// the "room-joined" ack below before firing sync requests), but this stays
// as a loud, client-visible backstop for any handler/event that still hits
// it — including ones added later that forget to wait for that ack.
function requireRoomAccess(socket, roomId, eventName) {
  if (roomId && socket.authorizedRooms.has(roomId)) return true;
  console.error(
    `[room-access] REJECTED "${eventName}" from ${socket.id} (user ${socket.user?.id}): no verified access to room ${roomId}`
  );
  socket.emit("room-access-error", { event: eventName, roomId, reason: "not-authorized" });
  return false;
}

// ── Socket handlers ───────────────────────────────────────────────────────────

function setupSocketHandlers(io) {
  // Runs before any "connection" listener — rejects the handshake outright if
  // the JWT is missing or invalid, so unauthenticated sockets never reach
  // room logic at all (previously only the REST API checked the token).
  io.use(socketAuthMiddleware);

  io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.id} (user ${socket.user.id})`);

    // Rooms this socket has been verified against (owner or participant),
    // populated only by a successful join-room below.
    socket.authorizedRooms = new Set();

    // ── join-room ─────────────────────────────────────────────────────────────
    // Identity comes from the verified JWT (socket.user), not the client
    // payload — a client can no longer claim to be someone else by passing a
    // different userName.
    //
    // Previously this joined whatever roomId the client sent with no check
    // at all, silently bypassing the REST layer's password gate — any
    // authenticated user could join any room's real-time channel, password-
    // protected or not. Now it requires owner-or-participant, same as
    // hasRoomAccess() in routes/rooms.js.
    socket.on("join-room", async ({ roomId }) => {
      const authorized = await authorizeRoomJoin(socket, roomId);
      if (!authorized) {
        console.warn(`Rejected join-room: user ${socket.user.id} has no access to room ${roomId}`);
        socket.emit("room-access-denied", { roomId });
        return;
      }

      socket.authorizedRooms.add(roomId);
      socket.join(roomId);
      socket.roomId   = roomId;
      socket.userName = socket.user.name;

      // Explicit ack that THIS socket is now authorized for THIS room — the
      // client waits for this before firing any room-scoped request that
      // isn't triggered by a user action (yjs-sync-request on mount, above
      // all), instead of racing it against this handler's DB-backed check
      // above. See requireRoomAccess's comment for what used to happen when
      // that race was lost.
      socket.emit("room-joined", { roomId });

      console.log(`${socket.userName} joined room ${roomId}`);

      io.to(roomId).emit("user-joined", {
        userName: socket.userName,
        socketId: socket.id,
      });

      // Send recent chat history
      try {
        const messages = await Message.find({ roomId })
          .sort({ createdAt: 1 })
          .limit(50);
        socket.emit("message-history", messages);
      } catch (err) {
        console.error("Error sending message history:", err.message);
      }

      const sockets = await io.in(roomId).fetchSockets();
      const participants = sockets.map((s) => ({
        socketId: s.id,
        userName: s.userName || "Anonymous",
      }));
      io.to(roomId).emit("participants-update", participants);
      await broadcastFilePresence(io, roomId);
    });


    // ── active-file-change ────────────────────────────────────────────────────
    socket.on("active-file-change", async ({ roomId, fileId }) => {
      if (!requireRoomAccess(socket, roomId, "active-file-change")) return;
      socket.activeFileId = fileId;
      await broadcastFilePresence(io, roomId);
    });

    // ── yjs-sync-request ─────────────────────────────────────────────────────
    // Client asks for the full Y.Doc state on mount / file switch.
    // We send the raw Uint8Array so Socket.io uses binary framing, not JSON.
    socket.on("yjs-sync-request", async ({ roomId, fileId }) => {
      if (!requireRoomAccess(socket, roomId, "yjs-sync-request")) return;
      socket.activeFileId = fileId;

      try {
        const ydoc = await getOrCreateYDoc(fileId);
        const state = Y.encodeStateAsUpdate(ydoc);
        socket.emit("yjs-sync-response", { fileId, state });
      } catch (err) {
        console.error("yjs-sync-request error:", err.message);
      }

      await broadcastFilePresence(io, roomId);
    });

    // ── yjs-update ────────────────────────────────────────────────────────────
    // Client sends an incremental Yjs update (result of a local edit).
    // Socket.io delivers the Uint8Array as a Node.js Buffer on the server.
    // We apply it to the server-side Y.Doc, relay the same Buffer to all
    // other sockets in this room (across instances too, via the
    // socket.io-redis-adapter), publish the diff to every OTHER instance's
    // local Y.Doc for this file (via Redis pub/sub), then schedule a DB save
    // and a full-content snapshot.
    socket.on("yjs-update", async ({ roomId, fileId, update }) => {
      if (!requireRoomAccess(socket, roomId, "yjs-update")) return;
      if (!fileId || !update) return;

      try {
        const ydoc = await getOrCreateYDoc(fileId);

        // Buffer is a Uint8Array subclass — Yjs accepts it directly.
        // Origin 'server' is set so the doc's own update listener (if any) won't
        // re-broadcast. We don't have one here, but this follows the convention.
        Y.applyUpdate(ydoc, update, "server");
        yjsUpdatesTotal.inc();

        // Relay the raw Buffer to every OTHER socket in the room.
        // Socket.io re-wraps it as binary for the receiving browsers.
        socket.to(roomId).emit("yjs-update", { fileId, update });

        // Fan the same diff out to every other backend instance so their
        // local Y.Docs for this file converge too — see subscribeToFileUpdates.
        // Deliberately NOT a full-state overwrite: two instances doing that
        // concurrently would race, and whichever SET landed last would
        // silently discard the other instance's edit.
        await publishUpdateDiff(fileId, update);

        // Read merged text for persistence (pure CRDT result, no last-write-wins)
        const content = ydoc.getText("content").toString();
        const yjsState = Y.encodeStateAsUpdate(ydoc);

        scheduleFileSave(fileId, content, yjsState, null, roomId);
        scheduleSnapshot(roomId, fileId, content, socket.userName);
        scheduleCommentReconcile(io, roomId, fileId);
      } catch (err) {
        console.error("yjs-update error:", err.message);
      }
    });


    // ── language-change ───────────────────────────────────────────────────────
    socket.on("language-change", ({ roomId, language, fileId }) => {
      if (!requireRoomAccess(socket, roomId, "language-change")) return;
      socket.to(roomId).emit("language-update", { language, fileId: fileId || null });
      if (fileId) {
        File.findByIdAndUpdate(fileId, { language }).catch((err) =>
          console.error("Language update error:", err.message)
        );
      }
    });

    // ── File CRUD announcements ───────────────────────────────────────────────

    socket.on("announce-file-created", ({ roomId, file }) => {
      if (!requireRoomAccess(socket, roomId, "announce-file-created")) return;
      socket.to(roomId).emit("file-created", { file });
    });

    socket.on("announce-file-renamed", ({ roomId, fileId, name, language }) => {
      if (!requireRoomAccess(socket, roomId, "announce-file-renamed")) return;
      socket.to(roomId).emit("file-renamed", { fileId, name, language });
    });

    socket.on("announce-file-deleted", ({ roomId, fileId }) => {
      if (!requireRoomAccess(socket, roomId, "announce-file-deleted")) return;
      // Clean up Y.Doc and all in-memory state for this file, on this instance...
      if (ydocs.has(fileId)) {
        ydocs.get(fileId).destroy();
        ydocs.delete(fileId);
      }
      ydocLocks.delete(fileId);
      // ...and the Redis-side state: stop listening for this file's diffs, and
      // drop the cold-start snapshot AND the replay stream so neither can
      // resurrect a deleted file for some other instance that opens it next.
      if (redisSubscriber) {
        redisSubscriber.unsubscribe(redisUpdatesKey(fileId)).catch((err) =>
          console.error(`Redis unsubscribe error for ${fileId}:`, err.message)
        );
      }
      if (redisClient) {
        redisClient.del(redisUpdatesKey(fileId)).catch((err) =>
          console.error(`Redis stream cleanup error for ${fileId}:`, err.message)
        );
        redisClient.del(redisSnapshotKey(fileId)).catch((err) =>
          console.error(`Redis snapshot cleanup error for ${fileId}:`, err.message)
        );
      }
      if (fileSaveTimers.has(fileId)) {
        clearTimeout(fileSaveTimers.get(fileId));
        fileSaveTimers.delete(fileId);
      }
      if (snapshotTimers.has(fileId)) {
        clearTimeout(snapshotTimers.get(fileId));
        snapshotTimers.delete(fileId);
      }
      if (commentReconcileTimers.has(fileId)) {
        clearTimeout(commentReconcileTimers.get(fileId));
        commentReconcileTimers.delete(fileId);
      }
      socket.to(roomId).emit("file-deleted", { fileId });
    });

    // ── Chat ──────────────────────────────────────────────────────────────────

    socket.on("load-messages", async ({ roomId }) => {
      if (!requireRoomAccess(socket, roomId, "load-messages")) return;
      try {
        const messages = await Message.find({ roomId })
          .sort({ createdAt: 1 })
          .limit(50);
        socket.emit("message-history", messages);
      } catch (err) {
        console.error("Error loading messages:", err.message);
      }
    });

    socket.on("send-message", async ({ roomId, text }) => {
      if (!requireRoomAccess(socket, roomId, "send-message")) return;
      if (!text?.trim()) return;
      try {
        const msg = await Message.create({
          roomId,
          userName: socket.userName || "Anonymous",
          text: text.trim(),
        });
        io.to(roomId).emit("new-message", {
          _id:       msg._id,
          userName:  msg.userName,
          text:      msg.text,
          createdAt: msg.createdAt,
        });
      } catch (err) {
        console.error("Error saving message:", err.message);
      }
    });

    // ── Cursors ───────────────────────────────────────────────────────────────
    socket.on("cursor-move", ({ roomId, position, selection, fileId }) => {
      if (!requireRoomAccess(socket, roomId, "cursor-move")) return;
      socket.to(roomId).emit("cursor-update", {
        socketId:  socket.id,
        userName:  socket.userName,
        position,
        selection: selection || null,
        fileId:    fileId || null,
      });
    });

    // ── Code execution ────────────────────────────────────────────────────────
    // runnerName comes from socket.userName (verified at join), not the client
    // payload — otherwise any client could claim someone else ran the code.
    //
    // run-result is intentionally NOT handled here anymore — it used to be a
    // plain client socket.emit with an arbitrary `output` string, completely
    // disconnected from whether a real Judge0 call ever happened (a client
    // could broadcast fake "output" to the whole room without ever running
    // anything). It's now only ever emitted server-side, from inside the
    // POST /:roomId/execute REST handler (routes/rooms.js), right after a
    // real Judge0 result comes back. A client emitting "run-result" today
    // just hits no listener — a no-op.

    socket.on("run-start", ({ roomId }) => {
      if (!requireRoomAccess(socket, roomId, "run-start")) return;
      io.to(roomId).emit("run-start", { runnerName: socket.userName });
    });

    // ── Typing indicators ─────────────────────────────────────────────────────

    socket.on("typing-start", ({ roomId }) => {
      if (!requireRoomAccess(socket, roomId, "typing-start")) return;
      socket.to(roomId).emit("user-typing", { userName: socket.userName });
    });

    socket.on("typing-stop", ({ roomId }) => {
      if (!requireRoomAccess(socket, roomId, "typing-stop")) return;
      socket.to(roomId).emit("user-stopped-typing", { userName: socket.userName });
    });

    // ── disconnect ────────────────────────────────────────────────────────────

    socket.on("disconnect", async () => {
      console.log(`Socket disconnected: ${socket.id}`);
      if (!socket.roomId) return;

      const roomId = socket.roomId;

      socket.to(roomId).emit("user-stopped-typing", { userName: socket.userName });
      io.to(roomId).emit("user-left", {
        userName: socket.userName,
        socketId: socket.id,
      });

      const sockets = await io.in(roomId).fetchSockets();
      const participants = sockets.map((s) => ({
        socketId: s.id,
        userName: s.userName || "Anonymous",
      }));
      io.to(roomId).emit("participants-update", participants);
      await broadcastFilePresence(io, roomId);
    });
  });
}

// ── Inline comments ───────────────────────────────────────────────────────────
// Comment CRUD lives in routes/rooms.js (REST, JWT-protected, room-access checked
// there). This just fans the resulting change out to everyone in the room over
// the socket, same as every other broadcast in this file.
function broadcastCommentEvent(io, roomId, event, payload) {
  io.to(roomId).emit(event, payload);
}

module.exports = { setupSocketHandlers, broadcastCommentEvent };
