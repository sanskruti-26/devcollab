// models/Room.js — MongoDB schema for a collaborative code room
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const roomSchema = new mongoose.Schema(
  {
    // Short unique room ID (shown in URL)
    roomId: { type: String, default: () => uuidv4().slice(0, 8), unique: true },
    name: { type: String, required: true, trim: true },
    // The actual code content in the editor
    content: { type: String, default: "// Start coding here...\n" },
    // Programming language for syntax highlighting
    language: {
      type: String,
      default: "javascript",
      enum: ["javascript", "typescript", "python", "java", "cpp"],
    },
    // Who created this room
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Everyone who has ever joined
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Room", roomSchema);
