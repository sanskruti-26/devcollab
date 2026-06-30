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
// Session replay: snapshots full content strings read from Y.Doc after each merged write.

const Y      = require("yjs");
const Room   = require("../models/Room");
const File   = require("../models/File");
const Message  = require("../models/Message");
const Snapshot = require("../models/Snapshot");
const Comment  = require("../models/Comment");

// ── In-memory caches ──────────────────────────────────────────────────────────

// Server-side Y.Doc per file. Bootstrapped from DB on first access.
// Map<fileId (string), Y.Doc>
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

// When each file's CURRENT server-side Y.Doc instance was created. A relative
// position encoded against an OLDER doc instance (e.g. one that existed before
// a server restart wiped the in-memory ydocs Map) can't be trusted against a
// freshly-rehydrated doc — it was hydrated from a flattened content string, not
// from Yjs history, so its internal item ids are unrelated to the old ones.
// Resolving an old anchor against it would falsely look like "text deleted".
// Map<fileId, Date>
const ydocCreatedAt = new Map();

// Debounce timers for comment-anchor reconciliation — keyed by fileId.
const commentReconcileTimers = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

// Returns the server-side Y.Doc for a file.
// Hot path (doc already created): synchronous map lookup, no await cost.
// Cold path (first access): creates exactly ONE Y.Doc, hydrates it from DB, then
// caches it. Any concurrent cold calls share the same creation promise so they all
// await the same hydrated doc — preventing the duplicate-clientID bug.
async function getOrCreateYDoc(fileId) {
  if (ydocs.has(fileId)) return ydocs.get(fileId);
  if (ydocLocks.has(fileId)) return ydocLocks.get(fileId);

  const promise = (async () => {
    const ydoc = new Y.Doc();
    try {
      const file = await File.findById(fileId);
      if (file?.content) {
        ydoc.getText("content").insert(0, file.content);
      }
    } catch (err) {
      console.error(`getOrCreateYDoc hydration error for ${fileId}:`, err.message);
    }
    ydocs.set(fileId, ydoc);
    ydocCreatedAt.set(fileId, new Date());
    ydocLocks.delete(fileId);
    return ydoc;
  })();

  ydocLocks.set(fileId, promise);
  return promise;
}

// Emit the current file-presence state to everyone in a room so they can show
// "who is viewing which file" indicators in the sidebar.
async function broadcastFilePresence(io, roomId) {
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

// Debounced save of a single File document (5 s).
function scheduleFileSave(fileId, content, language, roomId) {
  if (fileSaveTimers.has(fileId)) clearTimeout(fileSaveTimers.get(fileId));
  fileSaveTimers.set(
    fileId,
    setTimeout(async () => {
      try {
        const update = { content, $inc: { version: 1 } };
        if (language) update.language = language;
        await File.findByIdAndUpdate(fileId, update);
        console.log(`Auto-saved file ${fileId} (room ${roomId})`);
      } catch (err) {
        console.error("File auto-save error:", err.message);
      }
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
    const docCreatedAt = ydocCreatedAt.get(fileId);

    const deletedIds = [];

    for (const comment of comments) {
      // Don't trust resolution against a Y.Doc instance that didn't exist yet when
      // this comment's anchor was created (see ydocCreatedAt comment above) — leave
      // lineNumber as-is rather than risk deleting a comment for no real reason.
      if (docCreatedAt && comment.createdAt < docCreatedAt) continue;

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

// ── Socket handlers ───────────────────────────────────────────────────────────

function setupSocketHandlers(io) {
  io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // ── join-room ─────────────────────────────────────────────────────────────
    socket.on("join-room", async ({ roomId, userName }) => {
      socket.join(roomId);
      socket.roomId   = roomId;
      socket.userName = userName || "Anonymous";

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
      socket.activeFileId = fileId;
      await broadcastFilePresence(io, roomId);
    });

    // ── yjs-sync-request ─────────────────────────────────────────────────────
    // Client asks for the full Y.Doc state on mount / file switch.
    // We send the raw Uint8Array so Socket.io uses binary framing, not JSON.
    socket.on("yjs-sync-request", async ({ roomId, fileId }) => {
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
    // other sockets, then schedule a DB save and a full-content snapshot.
    socket.on("yjs-update", async ({ roomId, fileId, update }) => {
      if (!fileId || !update) return;

      try {
        const ydoc = await getOrCreateYDoc(fileId);

        // Buffer is a Uint8Array subclass — Yjs accepts it directly.
        // Origin 'server' is set so the doc's own update listener (if any) won't
        // re-broadcast. We don't have one here, but this follows the convention.
        Y.applyUpdate(ydoc, update, "server");

        // Relay the raw Buffer to every OTHER socket in the room.
        // Socket.io re-wraps it as binary for the receiving browsers.
        socket.to(roomId).emit("yjs-update", { fileId, update });

        // Read merged text for persistence (pure CRDT result, no last-write-wins)
        const content = ydoc.getText("content").toString();

        scheduleFileSave(fileId, content, null, roomId);
        scheduleSnapshot(roomId, fileId, content, socket.userName);
        scheduleCommentReconcile(io, roomId, fileId);
      } catch (err) {
        console.error("yjs-update error:", err.message);
      }
    });


    // ── language-change ───────────────────────────────────────────────────────
    socket.on("language-change", ({ roomId, language, fileId }) => {
      socket.to(roomId).emit("language-update", { language, fileId: fileId || null });
      if (fileId) {
        File.findByIdAndUpdate(fileId, { language }).catch((err) =>
          console.error("Language update error:", err.message)
        );
      }
    });

    // ── File CRUD announcements ───────────────────────────────────────────────

    socket.on("announce-file-created", ({ roomId, file }) => {
      socket.to(roomId).emit("file-created", { file });
    });

    socket.on("announce-file-renamed", ({ roomId, fileId, name, language }) => {
      socket.to(roomId).emit("file-renamed", { fileId, name, language });
    });

    socket.on("announce-file-deleted", ({ roomId, fileId }) => {
      // Clean up Y.Doc and all in-memory state for this file
      if (ydocs.has(fileId)) {
        ydocs.get(fileId).destroy();
        ydocs.delete(fileId);
      }
      ydocLocks.delete(fileId);
      ydocCreatedAt.delete(fileId);
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
      socket.to(roomId).emit("cursor-update", {
        socketId:  socket.id,
        userName:  socket.userName,
        position,
        selection: selection || null,
        fileId:    fileId || null,
      });
    });

    // ── Code execution ────────────────────────────────────────────────────────

    socket.on("run-start", ({ roomId, runnerName }) => {
      io.to(roomId).emit("run-start", { runnerName });
    });

    socket.on("run-result", ({ roomId, output, runnerName }) => {
      io.to(roomId).emit("run-result", { output, runnerName });
    });

    // ── Typing indicators ─────────────────────────────────────────────────────

    socket.on("typing-start", ({ roomId }) => {
      socket.to(roomId).emit("user-typing", { userName: socket.userName });
    });

    socket.on("typing-stop", ({ roomId }) => {
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
