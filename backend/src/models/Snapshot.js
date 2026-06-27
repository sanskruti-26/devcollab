// models/Snapshot.js — one snapshot per ~2 seconds of editing, used for session replay
const mongoose = require("mongoose");

const snapshotSchema = new mongoose.Schema({
  roomId:   { type: String, required: true, index: true },
  content:  { type: String, required: true },
  userName: { type: String, required: true }, // who was typing at this moment
}, { timestamps: true }); // createdAt is the TTL field + ordering key

// Auto-delete snapshots older than 7 days so Atlas stays small
snapshotSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });

module.exports = mongoose.model("Snapshot", snapshotSchema);
