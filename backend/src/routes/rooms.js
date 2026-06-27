// routes/rooms.js — CRUD for rooms, all protected by JWT
const router = require("express").Router();
const bcrypt = require("bcryptjs");
const auth = require("../middleware/auth");
const Room = require("../models/Room");
const Snapshot = require("../models/Snapshot");

// Helper — strips the password hash and adds hasPassword boolean
function safeRoom(room) {
  const obj = room.toObject ? room.toObject() : { ...room };
  obj.hasPassword = !!obj.password;
  delete obj.password;
  return obj;
}

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

// POST /api/v1/rooms — create a new room (optional password)
router.post("/", auth, async (req, res) => {
  try {
    const { name, language, password } = req.body;
    if (!name) return res.status(400).json({ error: "Room name required" });

    const hashedPassword = password?.trim() ? await bcrypt.hash(password.trim(), 10) : null;

    const room = await Room.create({
      name,
      language: language || "javascript",
      owner: req.user.id,
      participants: [req.user.id],
      password: hashedPassword,
    });
    res.status(201).json(safeRoom(room));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/rooms/:roomId/replay — ordered snapshots for session replay
// Access: owner always allowed. For password-protected rooms, participant membership
// is used as proof of prior access — the user already verified the password when
// they joined, so we don't ask for it again here.
router.get("/:roomId/replay", auth, async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) return res.status(404).json({ error: "Room not found" });

    const isOwner = room.owner.toString() === req.user.id;
    const isParticipant = room.participants.some((p) => p.toString() === req.user.id);

    if (room.password && !isOwner && !isParticipant) {
      // User has never verified the room password — deny access
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

// DELETE /api/v1/rooms/:roomId — delete a room (owner only)
router.delete("/:roomId", auth, async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) return res.status(404).json({ error: "Room not found" });
    if (room.owner.toString() !== req.user.id)
      return res.status(403).json({ error: "Only the owner can delete this room" });

    await room.deleteOne();
    res.json({ message: "Room deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
