// lib/socket.js — single Socket.io client instance
// Import this wherever you need real-time features
import { io } from "socket.io-client";

const socket = io(import.meta.env.VITE_SOCKET_URL || "http://localhost:5000", {
  autoConnect: false, // We connect manually when entering a room
  // A function (not a static object) so the token is re-read from localStorage
  // on every reconnect attempt, not just the first — matters if the user logged
  // in/out, or the token rotated, since the last time this socket connected.
  auth: (cb) => cb({ token: localStorage.getItem("token") }),
});

export default socket;
