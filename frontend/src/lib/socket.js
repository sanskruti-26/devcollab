// lib/socket.js — single Socket.io client instance
// Import this wherever you need real-time features
import { io } from "socket.io-client";

const socket = io(import.meta.env.VITE_SOCKET_URL || "http://localhost:5000", {
  autoConnect: false, // We connect manually when entering a room
  // A function (not a static object) so the token is re-read from localStorage
  // on every reconnect attempt, not just the first — matters if the user logged
  // in/out, or the token rotated, since the last time this socket connected.
  auth: (cb) => cb({ token: localStorage.getItem("token") }),
  // Skip Socket.io's default HTTP-polling-then-upgrade handshake and open a
  // WebSocket directly. Without this, the polling request and the later
  // upgrade request are two separate HTTP requests, and a round-robin load
  // balancer (nginx, see docker-compose.yml) can send them to two different
  // backend instances, which Socket.io sees as a broken handshake. Going
  // straight to WebSocket makes each connection a single request, so
  // round-robin works without needing sticky sessions.
  transports: ["websocket"],
});

export default socket;
