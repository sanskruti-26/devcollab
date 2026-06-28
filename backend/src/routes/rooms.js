// routes/rooms.js — CRUD for rooms and files, all protected by JWT
const router = require("express").Router();
const bcrypt = require("bcryptjs");
const auth = require("../middleware/auth");
const Room = require("../models/Room");
const File = require("../models/File");
const Snapshot = require("../models/Snapshot");

// ─── Helpers ────────────────────────────────────────────────────────────────

// Strips the password hash and adds hasPassword boolean
function safeRoom(room) {
  const obj = room.toObject ? room.toObject() : { ...room };
  obj.hasPassword = !!obj.password;
  delete obj.password;
  return obj;
}

// Per-language default file name
function defaultFileName(language) {
  const names = {
    javascript: "main.js",
    typescript: "main.ts",
    python:     "main.py",
    java:       "Main.java",
    cpp:        "main.cpp",
  };
  return names[language] || "main.js";
}

// Per-language starter content (slightly richer than the old single-line default)
function defaultContent(language) {
  const starters = {
    javascript: "// Start coding here\n",
    typescript: "// Start coding here\n",
    python:     "# Start coding here\n",
    java:       "public class Main {\n    public static void main(String[] args) {\n        // Start coding here\n    }\n}\n",
    cpp:        '#include <iostream>\nusing namespace std;\n\nint main() {\n    // Start coding here\n    return 0;\n}\n',
  };
  return starters[language] || "// Start coding here\n";
}

// Infer Monaco language from file extension (returns null if unknown)
function inferLanguage(name) {
  const ext = name.split(".").pop().toLowerCase();
  const map = {
    js: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript",
    py: "python",
    java: "java",
    cpp: "cpp", cc: "cpp", cxx: "cpp", h: "cpp", hpp: "cpp",
  };
  return map[ext] || null;
}

// Check if a user has access to a room (owner or past participant)
function hasRoomAccess(room, userId) {
  return (
    room.owner.toString() === userId ||
    room.participants.some((p) => p.toString() === userId)
  );
}

// ─── Room routes ─────────────────────────────────────────────────────────────

// GET /api/v1/rooms — list rooms the logged-in user owns or has joined
router.get("/", auth, async (req, res) => {
  try {
    const rooms = await Room.find({
      $or: [{ owner: req.user.id }, { participants: req.user.id }],
    })
      .sort({ updatedAt: -1 })
      .select("roomId name language owner updatedAt password");
    res.json(rooms.map(safeRoom));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/rooms — create a new room and its first default file
router.post("/", auth, async (req, res) => {
  try {
    const { name, language, password } = req.body;
    if (!name) return res.status(400).json({ error: "Room name required" });

    const lang = language || "javascript";
    const hashedPassword = password?.trim() ? await bcrypt.hash(password.trim(), 10) : null;

    const room = await Room.create({
      name,
      language: lang,
      owner: req.user.id,
      participants: [req.user.id],
      password: hashedPassword,
    });

    // Every new room starts with one default file
    await File.create({
      roomId: room.roomId,
      name: defaultFileName(lang),
      language: lang,
      content: defaultContent(lang),
      version: 0,
    });

    res.status(201).json(safeRoom(room));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Session replay ───────────────────────────────────────────────────────────

// GET /api/v1/rooms/:roomId/replay — ordered snapshots for session replay
// Replay stays per-room for now; Stage 2 adds per-file replay.
router.get("/:roomId/replay", auth, async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) return res.status(404).json({ error: "Room not found" });

    const isOwner = room.owner.toString() === req.user.id;
    const isParticipant = room.participants.some((p) => p.toString() === req.user.id);

    if (room.password && !isOwner && !isParticipant) {
      return res.status(403).json({ requiresPassword: true });
    }

    const snapshots = await Snapshot.find({ roomId: req.params.roomId })
      .sort({ createdAt: 1 })
      .select("content userName createdAt")
      .limit(500);

    console.log(`Replay: room=${req.params.roomId} user=${req.user.id} snapshots=${snapshots.length}`);
    res.json(snapshots);
  } catch (err) {
    console.error("Replay error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── File routes ──────────────────────────────────────────────────────────────

// GET /api/v1/rooms/:roomId/files — list all files in a room
// Backward compat: if no files exist yet (old room), seeds one from room.content
router.get("/:roomId/files", auth, async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) return res.status(404).json({ error: "Room not found" });
    if (!hasRoomAccess(room, req.user.id))
      return res.status(403).json({ error: "Not a member of this room" });

    let files = await File.find({ roomId: req.params.roomId }).sort({ createdAt: 1 });

    // Old room with no files yet — seed from the legacy room.content field
    if (files.length === 0) {
      try {
        const seedFile = await File.create({
          roomId: req.params.roomId,
          name: defaultFileName(room.language),
          language: room.language,
          content: room.content || defaultContent(room.language),
          version: 0,
        });
        files = [seedFile];
        console.log(`Seeded default file for legacy room ${req.params.roomId}`);
      } catch (err) {
        if (err.code === 11000) {
          // Race condition: another request seeded first — just re-fetch
          files = await File.find({ roomId: req.params.roomId }).sort({ createdAt: 1 });
        } else {
          throw err;
        }
      }
    }

    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/rooms/:roomId/files — create a new file in a room
router.post("/:roomId/files", auth, async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) return res.status(404).json({ error: "Room not found" });
    if (!hasRoomAccess(room, req.user.id))
      return res.status(403).json({ error: "Not a member of this room" });

    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "File name required" });

    const lang = inferLanguage(name.trim()) || room.language;

    const file = await File.create({
      roomId: req.params.roomId,
      name: name.trim(),
      language: lang,
      content: defaultContent(lang),
      version: 0,
    });

    res.status(201).json(file);
  } catch (err) {
    if (err.code === 11000)
      return res.status(409).json({ error: "A file with that name already exists" });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/v1/rooms/:roomId/files/:fileId — rename a file (and infer new language)
router.patch("/:roomId/files/:fileId", auth, async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) return res.status(404).json({ error: "Room not found" });
    if (!hasRoomAccess(room, req.user.id))
      return res.status(403).json({ error: "Not a member of this room" });

    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "File name required" });

    const updateFields = { name: name.trim() };
    const inferredLang = inferLanguage(name.trim());
    if (inferredLang) updateFields.language = inferredLang;

    const file = await File.findOneAndUpdate(
      { _id: req.params.fileId, roomId: req.params.roomId },
      updateFields,
      { new: true }
    );
    if (!file) return res.status(404).json({ error: "File not found" });

    res.json(file);
  } catch (err) {
    if (err.code === 11000)
      return res.status(409).json({ error: "A file with that name already exists" });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/rooms/:roomId/files/:fileId — delete a file (last file cannot be deleted)
router.delete("/:roomId/files/:fileId", auth, async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) return res.status(404).json({ error: "Room not found" });
    if (!hasRoomAccess(room, req.user.id))
      return res.status(403).json({ error: "Not a member of this room" });

    const count = await File.countDocuments({ roomId: req.params.roomId });
    if (count <= 1)
      return res.status(400).json({ error: "Cannot delete the last file in a room" });

    const file = await File.findOneAndDelete({
      _id: req.params.fileId,
      roomId: req.params.roomId,
    });
    if (!file) return res.status(404).json({ error: "File not found" });

    res.json({ message: "File deleted", fileId: req.params.fileId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Single room ──────────────────────────────────────────────────────────────

// GET /api/v1/rooms/:roomId — get a single room by its short ID
// If the room has a password, the caller must pass ?password=xxx
router.get("/:roomId", auth, async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) return res.status(404).json({ error: "Room not found" });

    // Password check — owners bypass it
    if (room.password && room.owner.toString() !== req.user.id) {
      const provided = req.query.password;
      if (!provided) return res.status(403).json({ requiresPassword: true });
      const valid = await bcrypt.compare(provided, room.password);
      if (!valid) return res.status(403).json({ error: "Wrong password" });
    }

    // Add user to participants if not already there
    if (!room.participants.includes(req.user.id)) {
      room.participants.push(req.user.id);
      await room.save();
    }

    res.json(safeRoom(room));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Code execution ───────────────────────────────────────────────────────────

// POST /api/v1/rooms/execute — run code via Judge0 CE (RapidAPI)
// Language IDs: JS=63, TS=74, Python=71, Java=62, C++=54
router.post("/execute", auth, async (req, res) => {
  const { code, language } = req.body;
  if (!code) return res.status(400).json({ error: "Code is required" });

  if (!process.env.JUDGE0_KEY) {
    return res.status(503).json({ error: "Code execution not configured — add JUDGE0_KEY to backend/.env" });
  }

  const LANGUAGE_IDS = { javascript: 63, typescript: 74, python: 71, java: 62, cpp: 54 };
  const languageId = LANGUAGE_IDS[language] || 63;

  try {
    const response = await fetch(
      "https://judge0-ce.p.rapidapi.com/submissions?base64_encoded=false&wait=true",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-RapidAPI-Key": process.env.JUDGE0_KEY,
          "X-RapidAPI-Host": "judge0-ce.p.rapidapi.com",
        },
        body: JSON.stringify({ source_code: code, language_id: languageId }),
      }
    );

    const result = await response.json();
    const output =
      result.stdout || result.stderr || result.compile_output || result.message || "(no output)";

    res.json({ output: output.trim(), status: result.status?.description });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Room deletion ────────────────────────────────────────────────────────────

// DELETE /api/v1/rooms/:roomId — delete a room and all its files (owner only)
router.delete("/:roomId", auth, async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) return res.status(404).json({ error: "Room not found" });
    if (room.owner.toString() !== req.user.id)
      return res.status(403).json({ error: "Only the owner can delete this room" });

    await Promise.all([
      room.deleteOne(),
      File.deleteMany({ roomId: req.params.roomId }),
    ]);

    res.json({ message: "Room deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
