// routes/rooms.js — CRUD for rooms, all protected by JWT
const router = require("express").Router();
const auth = require("../middleware/auth");
const Room = require("../models/Room");

// GET /api/v1/rooms — list rooms the logged-in user owns or has joined
router.get("/", auth, async (req, res) => {
  try {
    const rooms = await Room.find({
      $or: [{ owner: req.user.id }, { participants: req.user.id }],
    })
      .sort({ updatedAt: -1 })
      .select("roomId name language owner updatedAt");
    res.json(rooms);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/rooms — create a new room
router.post("/", auth, async (req, res) => {
  try {
    const { name, language } = req.body;
    if (!name) return res.status(400).json({ error: "Room name required" });

    const room = await Room.create({
      name,
      language: language || "javascript",
      owner: req.user.id,
      participants: [req.user.id],
    });
    res.status(201).json(room);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/rooms/:roomId — get a single room by its short ID
router.get("/:roomId", auth, async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) return res.status(404).json({ error: "Room not found" });

    // Add user to participants if not already there
    if (!room.participants.includes(req.user.id)) {
      room.participants.push(req.user.id);
      await room.save();
    }

    res.json(room);
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
