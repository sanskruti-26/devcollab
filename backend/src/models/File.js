// models/File.js — one file within a collaborative room
const mongoose = require("mongoose");

const fileSchema = new mongoose.Schema(
  {
    // Short room ID (matches Room.roomId, not Room._id)
    roomId: { type: String, required: true, index: true },
    // Display name shown in the file tree, e.g. "main.js"
    name: { type: String, required: true, trim: true },
    language: {
      type: String,
      default: "javascript",
      enum: ["javascript", "typescript", "python", "java", "cpp"],
    },
    content: { type: String, default: "" },
    // Incremented on every saved code-change — used in Stage 2 for stale-write detection
    version: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// A room cannot have two files with the same name
fileSchema.index({ roomId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("File", fileSchema);
