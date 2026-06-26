// server.js — Entry point for DevCollab backend
// Starts Express + Socket.io server, connects to MongoDB

require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const mongoose = require("mongoose");

const authRoutes = require("./routes/auth");
const roomRoutes = require("./routes/rooms");
const { setupSocketHandlers } = require("./services/roomService");

const app = express();
const server = http.createServer(app);

// Socket.io setup — allow requests from the frontend
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});

// Middleware
app.use(cors({ origin: process.env.CLIENT_URL || "http://localhost:5173" }));
app.use(express.json());

// Routes
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/rooms", roomRoutes);

// Health check
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Socket.io real-time handlers
setupSocketHandlers(io);

// Connect to MongoDB then start server
const PORT = process.env.PORT || 5000;
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("Connected to MongoDB");
    server.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  });
