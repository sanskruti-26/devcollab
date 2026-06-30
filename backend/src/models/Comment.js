// models/Comment.js — inline discussion thread anchored to a line of code
const mongoose = require("mongoose");

const commentSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true },
    fileId: { type: mongoose.Schema.Types.ObjectId, ref: "File", required: true, index: true },
    // Anchor is just a line number — if the file is heavily edited above this line,
    // the comment can drift from the code it was meant for. Acceptable tradeoff for now.
    lineNumber: { type: Number, required: true, min: 1 },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    userName: { type: String, required: true },
    // Computed once at creation time (same hash-based palette as live cursors) and
    // stored, so a thread doesn't change color retroactively if it's reused later.
    userColor: { type: String, required: true },
    // trim runs before validation, so whitespace-only text fails minlength too
    text: { type: String, required: true, trim: true, minlength: 1, maxlength: 2000 },
    // Top-level comments have parentId = null; replies point at the thread's root comment.
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: "Comment", default: null, index: true },
    resolved: { type: Boolean, default: false },
    // Opaque, base64-encoded Yjs relative position (Y.encodeRelativePosition) anchoring
    // this comment to a specific character in the file's Y.Text, so it follows edits
    // instead of staying pinned to a stale line number. Null for replies (they inherit
    // the root's line) and for comments created before this field existed — those keep
    // behaving exactly as before, pinned to lineNumber forever.
    relativePos: { type: String, default: null },
  },
  { timestamps: true }
);

// Fetching all comments for the file currently open in the editor
commentSchema.index({ roomId: 1, fileId: 1 });

module.exports = mongoose.model("Comment", commentSchema);
