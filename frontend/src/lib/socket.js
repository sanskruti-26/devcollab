// lib/socket.js — single Socket.io client instance
// Import this wherever you need real-time features
import { io } from "socket.io-client";

const socket = io(import.meta.env.VITE_SOCKET_URL || "http://localhost:5000", {
  autoConnect: false, // We connect manually when entering a room
});

export default socket;
