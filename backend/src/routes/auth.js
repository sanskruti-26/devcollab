// routes/auth.js — /api/v1/auth/register and /api/v1/auth/login
const router    = require("express").Router();
const jwt       = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const User      = require("../models/User");

// 10 login attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs:      15 * 60 * 1000,
  max:           10,
  standardHeaders: true,
  legacyHeaders:  false,
  message: { error: "Too many login attempts — please try again in 15 minutes" },
});

// 5 registrations per hour per IP
const registerLimiter = rateLimit({
  windowMs:      60 * 60 * 1000,
  max:           5,
  standardHeaders: true,
  legacyHeaders:  false,
  message: { error: "Too many accounts created from this IP — please try again later" },
});

function signToken(user) {
  return jwt.sign(
    { id: user._id, name: user.name, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

// POST /api/v1/auth/register
router.post("/register", registerLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: "All fields required" });

    const exists = await User.findOne({ email });
    if (exists)
      return res.status(400).json({ error: "Email already registered" });

    const user = await User.create({ name, email, password });
    const token = signToken(user);
    res.status(201).json({ token, user: { id: user._id, name, email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/auth/login
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email and password required" });

    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const token = signToken(user);
    res.json({ token, user: { id: user._id, name: user.name, email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
