// services/roomService.js — Socket.io real-time logic
//
// How it works:
// 1. User opens /room/:roomId → frontend connects + emits "join-room"
// 2. Server puts the socket in a Socket.io "room" (a named channel)
// 3. When a user types, frontend emits "code-change" with { roomId, code, language, fileId }
// 4. Server broadcasts the change to everyone else and debounces a DB save
// 5. Every 5 seconds the latest content is saved to the File document
//
// Multi-file transition
// ─────────────────────
// Stage 2 backend is fully backward-compatible with the Stage 1 (old) frontend.
//   • code-change WITHOUT fileId  → legacy path: saves to Room.content + syncs first File
//   • code-change WITH fileId     → new path: saves only to the File document
// New events (join-file, active-file-change, announce-file-*) are additive and
// ignored until the Stage 3 frontend starts emitting them.

const Room     = require("../models/Room");
const File     = require("../models/File");
const Message  = require("../models/Message");
const Snapshot = require("../models/Snapshot");

// ── In-memory caches ──────────────────────────────────────────────────────────

// Legacy room-level cache: roomId → latest code string.
// Updated by the legacy code-change path (no fileId). Kept so join-room can
// serve init-code without a DB round-trip on hot paths.
const roomCodeCache = new Map();

// Per-file cache: fileId (string) → latest content string.
// Updated by the new code-change path (with fileId). Used by join-file.
const fileCodeCache = new Map();

// Debounce timers for legacy room saves: roomId → setTimeout handle
const saveTimers = new Map();

// Debounce timers for per-file saves: fileId → setTimeout handle
const fileSaveTimers = new Map();

// Debounce timers for snapshots — keyed by fileId when available, else roomId.
const snapshotTimers = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// Debounced save of a single File document (5 s). Also increments version so
// clients can detect whether their local state is stale.
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

// Debounced snapshot for session replay (2 s throttle, one per file or per room).
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

// ── Socket handlers ───────────────────────────────────────────────────────────

function setupSocketHandlers(io) {
  io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // ── join-room ─────────────────────────────────────────────────────────────
    socket.on("join-room", async ({ roomId, userName }) => {
      socket.join(roomId);
      socket.roomId  = roomId;
      socket.userName = userName || "Anonymous";

      console.log(`${socket.userName} joined room ${roomId}`);

      // Send the current code to the newly joined user.
      // Priority: hot in-memory cache → File model → Room.content (legacy fallback).
      if (roomCodeCache.has(roomId)) {
        socket.emit("init-code", { code: roomCodeCache.get(roomId) });
      } else {
        try {
          const firstFile = await File.findOne({ roomId }).sort({ createdAt: 1 });
          if (firstFile) {
            const content = fileCodeCache.has(firstFile._id.toString())
              ? fileCodeCache.get(firstFile._id.toString())
              : firstFile.content;
            // Warm the legacy cache so the next join-room is instant
            roomCodeCache.set(roomId, content);
            socket.emit("init-code", { code: content });
          } else {
            const room = await Room.findOne({ roomId });
            if (room) {
              roomCodeCache.set(roomId, room.content);
              socket.emit("init-code", { code: room.content });
            }
          }
        } catch (err) {
          console.error("Error fetching initial code:", err.message);
        }
      }

      // Tell everyone in the room that someone joined
      io.to(roomId).emit("user-joined", {
        userName: socket.userName,
        socketId: socket.id,
      });

      // Send recent chat history to the newly joined user
      try {
        const messages = await Message.find({ roomId })
          .sort({ createdAt: 1 })
          .limit(50);
        socket.emit("message-history", messages);
      } catch (err) {
        console.error("Error sending message history:", err.message);
      }

      // Broadcast updated participant list
      const sockets = await io.in(roomId).fetchSockets();
      const participants = sockets.map((s) => ({
        socketId: s.id,
        userName: s.userName || "Anonymous",
      }));
      io.to(roomId).emit("participants-update", participants);

      // Broadcast updated file presence so sidebar indicators refresh
      await broadcastFilePresence(io, roomId);
    });

    // ── join-file ─────────────────────────────────────────────────────────────
    // Stage 3 frontend emits this when the user opens or switches to a file.
    // Server responds with init-file so the editor loads the correct content.
    socket.on("join-file", async ({ roomId, fileId }) => {
      socket.activeFileId = fileId;

      try {
        const file = await File.findById(fileId);
        if (file) {
          // Use the in-memory cache for content (freshest), DB for metadata
          const content = fileCodeCache.has(fileId)
            ? fileCodeCache.get(fileId)
            : file.content;
          fileCodeCache.set(fileId, content);

          socket.emit("init-file", {
            fileId,
            content,
            language: file.language,
            version:  file.version,
          });
        }
      } catch (err) {
        console.error("Error sending file init:", err.message);
      }

      await broadcastFilePresence(io, roomId);
    });

    // ── active-file-change ────────────────────────────────────────────────────
    // User clicks a different file tab without needing new content (they already
    // have the content). Just update presence so others' sidebars refresh.
    socket.on("active-file-change", async ({ roomId, fileId }) => {
      socket.activeFileId = fileId;
      await broadcastFilePresence(io, roomId);
    });

    // ── code-change ───────────────────────────────────────────────────────────
    socket.on("code-change", ({ roomId, code, language, fileId }) => {
      if (fileId) {
        // ── New per-file path (Stage 3 frontend) ──────────────────────────────
        fileCodeCache.set(fileId, code);
        // Keep roomCodeCache in sync so join-room init-code still works
        roomCodeCache.set(roomId, code);
        socket.to(roomId).emit("code-update", { code, language, fileId });
        scheduleFileSave(fileId, code, language, roomId);
        scheduleSnapshot(roomId, fileId, code, socket.userName);
      } else {
        // ── Legacy path (current frontend, no fileId) ─────────────────────────
        roomCodeCache.set(roomId, code);
        socket.to(roomId).emit("code-update", { code, language });

        // Debounced save: update Room.content (legacy) AND sync to the first
        // File document so the Stage 3 frontend sees fresh content after deploy.
        if (saveTimers.has(roomId)) clearTimeout(saveTimers.get(roomId));
        saveTimers.set(
          roomId,
          setTimeout(async () => {
            try {
              await Room.findOneAndUpdate(
                { roomId },
                { content: code, ...(language && { language }) }
              );
              // Sync first File so Stage 3 gets up-to-date content on cold load
              const firstFile = await File.findOne({ roomId }).sort({ createdAt: 1 });
              if (firstFile) {
                fileCodeCache.set(firstFile._id.toString(), code);
                await File.findByIdAndUpdate(firstFile._id, {
                  content: code,
                  $inc: { version: 1 },
                  ...(language && { language }),
                });
              }
              console.log(`Auto-saved room ${roomId} (legacy)`);
            } catch (err) {
              console.error("Auto-save error:", err.message);
            }
          }, 5000)
        );

        scheduleSnapshot(roomId, null, code, socket.userName);
      }
    });

    // ── language-change ───────────────────────────────────────────────────────
    socket.on("language-change", ({ roomId, language, fileId }) => {
      socket.to(roomId).emit("language-update", { language, fileId: fileId || null });

      // Persist language change to the File document when fileId is provided
      if (fileId) {
        File.findByIdAndUpdate(fileId, { language }).catch((err) =>
          console.error("Language update error:", err.message)
        );
      }
    });

    // ── File CRUD announcements ───────────────────────────────────────────────
    // Pattern: frontend calls REST endpoint → REST creates/renames/deletes →
    // frontend emits one of these → server re-broadcasts so all other tabs update.

    socket.on("announce-file-created", ({ roomId, file }) => {
      socket.to(roomId).emit("file-created", { file });
    });

    socket.on("announce-file-renamed", ({ roomId, fileId, name, language }) => {
      socket.to(roomId).emit("file-renamed", { fileId, name, language });
    });

    socket.on("announce-file-deleted", ({ roomId, fileId }) => {
      // Clean up in-memory state for the deleted file
      fileCodeCache.delete(fileId);
      if (fileSaveTimers.has(fileId)) {
        clearTimeout(fileSaveTimers.get(fileId));
        fileSaveTimers.delete(fileId);
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
    // fileId is passed through transparently. Stage 3 frontend will filter out
    // cursors that belong to a different file than the one being viewed.
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

      // Broadcast updated participant list
      const sockets = await io.in(roomId).fetchSockets();
      const participants = sockets.map((s) => ({
        socketId: s.id,
        userName: s.userName || "Anonymous",
      }));
      io.to(roomId).emit("participants-update", participants);

      // Remove this user from file presence
      await broadcastFilePresence(io, roomId);
    });
  });
}

module.exports = { setupSocketHandlers };
