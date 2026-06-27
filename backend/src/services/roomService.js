// services/roomService.js — Socket.io real-time logic
// This is the core of DevCollab: syncing code edits across all users in a room.
//
// How it works:
// 1. User opens /room/:roomId in browser
// 2. Frontend connects to Socket.io and emits "join-room"
// 3. Server puts the socket in a Socket.io "room" (a named channel)
// 4. When any user types, frontend emits "code-change" with the new code
// 5. Server broadcasts that change to everyone else in the room
// 6. Every 5 seconds, the latest code is auto-saved to MongoDB

const Room = require("../models/Room");
const Message = require("../models/Message");

// In-memory map: roomId -> latest code (for fast reads between DB saves)
const roomCodeCache = new Map();

// Debounce timers for auto-save: roomId -> setTimeout handle
const saveTimers = new Map();

function setupSocketHandlers(io) {
  io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // User joins a room
    socket.on("join-room", async ({ roomId, userName }) => {
      socket.join(roomId);
      socket.roomId = roomId;
      socket.userName = userName || "Anonymous";

      console.log(`${socket.userName} joined room ${roomId}`);

      // Send the current code to the newly joined user
      // Check cache first, then DB
      if (roomCodeCache.has(roomId)) {
        socket.emit("init-code", { code: roomCodeCache.get(roomId) });
      } else {
        try {
          const room = await Room.findOne({ roomId });
          if (room) {
            roomCodeCache.set(roomId, room.content);
            socket.emit("init-code", { code: room.content });
          }
        } catch (err) {
          console.error("Error fetching room:", err.message);
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

      // Send current participant list
      const sockets = await io.in(roomId).fetchSockets();
      const participants = sockets.map((s) => ({
        socketId: s.id,
        userName: s.userName || "Anonymous",
      }));
      io.to(roomId).emit("participants-update", participants);
    });

    // User typed something — broadcast to everyone else in the room
    socket.on("code-change", ({ roomId, code, language }) => {
      // Update cache immediately
      roomCodeCache.set(roomId, code);

      // Broadcast to everyone EXCEPT the sender
      socket.to(roomId).emit("code-update", { code, language });

      // Debounced auto-save to MongoDB every 5 seconds
      if (saveTimers.has(roomId)) clearTimeout(saveTimers.get(roomId));
      saveTimers.set(
        roomId,
        setTimeout(async () => {
          try {
            await Room.findOneAndUpdate(
              { roomId },
              { content: code, ...(language && { language }) }
            );
            console.log(`Auto-saved room ${roomId}`);
          } catch (err) {
            console.error("Auto-save error:", err.message);
          }
        }, 5000)
      );
    });

    // User changed the language
    socket.on("language-change", ({ roomId, language }) => {
      socket.to(roomId).emit("language-update", { language });
    });

    // User requests recent chat history when joining
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

    // User sends a chat message — save it and broadcast to everyone in the room
    socket.on("send-message", async ({ roomId, text }) => {
      if (!text?.trim()) return;
      try {
        const msg = await Message.create({
          roomId,
          userName: socket.userName || "Anonymous",
          text: text.trim(),
        });
        io.to(roomId).emit("new-message", {
          _id: msg._id,
          userName: msg.userName,
          text: msg.text,
          createdAt: msg.createdAt,
        });
      } catch (err) {
        console.error("Error saving message:", err.message);
      }
    });

    // User moved cursor or changed selection — broadcast to others
    socket.on("cursor-move", ({ roomId, position, selection }) => {
      socket.to(roomId).emit("cursor-update", {
        socketId: socket.id,
        userName: socket.userName,
        position,
        selection: selection || null,
      });
    });

    // User started typing in chat
    socket.on("typing-start", ({ roomId }) => {
      socket.to(roomId).emit("user-typing", { userName: socket.userName });
    });

    // User stopped typing in chat
    socket.on("typing-stop", ({ roomId }) => {
      socket.to(roomId).emit("user-stopped-typing", { userName: socket.userName });
    });

    // User disconnected
    socket.on("disconnect", async () => {
      console.log(`Socket disconnected: ${socket.id}`);
      if (!socket.roomId) return;

      const roomId = socket.roomId;

      // Clear their typing indicator for others
      socket.to(roomId).emit("user-stopped-typing", { userName: socket.userName });

      // Tell everyone else they left
      io.to(roomId).emit("user-left", {
        userName: socket.userName,
        socketId: socket.id,
      });

      // Update participant list
      const sockets = await io.in(roomId).fetchSockets();
      const participants = sockets.map((s) => ({
        socketId: s.id,
        userName: s.userName || "Anonymous",
      }));
      io.to(roomId).emit("participants-update", participants);
    });
  });
}

module.exports = { setupSocketHandlers };
