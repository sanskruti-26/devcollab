// server.js — Entry point for DevCollab backend
// Starts Express + Socket.io server, connects to MongoDB

require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const { createClient } = require("redis");
const cors = require("cors");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./routes/auth");
const roomRoutes = require("./routes/rooms");
const aiRoutes   = require("./routes/ai");
const { setupSocketHandlers } = require("./services/roomService");

// General API: 200 requests per minute per IP — generous for real-time collab
// but blocks bots hammering the rooms/files/execute endpoints.
// Auth-route limiters (login/register) live in routes/auth.js, applied inline.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down" },
});

const app = express();
const server = http.createServer(app);

// Trim whitespace/newlines Render sometimes injects into env var values
const CLIENT_URL = (process.env.CLIENT_URL || "http://localhost:5173").trim();

// Socket.io setup — allow requests from the frontend
const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    methods: ["GET", "POST"],
  },
});

// Exposed so REST routes (e.g. comments in routes/rooms.js) can broadcast
// over the room's socket channel after a DB write, without importing socket.io
// logic into the routes themselves.
app.set("io", io);

// Trust the first proxy hop so req.ip contains the real client IP behind Render's
// load balancer. Without this, express-rate-limit v8 detects X-Forwarded-For and
// bypasses rate limiting entirely to avoid incorrectly blocking all users who
// share the proxy's IP address.
app.set("trust proxy", 1);

// Middleware
app.use(cors({ origin: CLIENT_URL }));
app.use(express.json());

// Routes (auth limiters are applied inline inside routes/auth.js)
app.use("/api/v1/auth",  authRoutes);
app.use("/api/v1/rooms", apiLimiter, roomRoutes);
app.use("/api/v1/ai",    aiRoutes);   // AI limiter is applied per-route inside routes/ai.js

// Health check
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Socket.io real-time handlers
setupSocketHandlers(io);

// Socket.io's default adapter only broadcasts to sockets connected to the SAME
// process. Running more than one backend instance behind a load balancer (see
// docker-compose.yml) means io.to()/socket.to() would silently drop events
// bound for a socket on another instance — two users landing on different
// instances would never see each other's edits. The Redis adapter relays every
// broadcast through Redis pub/sub so all instances receive it. Optional: only
// attaches when REDIS_URL is set, so single-instance local dev (`npm run dev`
// without Redis running) still works with the default in-memory adapter.
async function attachRedisAdapter() {
  if (!process.env.REDIS_URL) return;
  const pubClient = createClient({ url: process.env.REDIS_URL });
  const subClient = pubClient.duplicate();
  pubClient.on("error", (err) => console.error("Redis pub client error:", err.message));
  subClient.on("error", (err) => console.error("Redis sub client error:", err.message));
  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));
  console.log("Socket.io Redis adapter connected");
}

// Connect to MongoDB + (optionally) Redis, then start server
const PORT = process.env.PORT || 5000;
Promise.all([mongoose.connect(process.env.MONGODB_URI), attachRedisAdapter()])
  .then(() => {
    console.log("Connected to MongoDB");
    server.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Startup error:", err.message);
    process.exit(1);
  });
