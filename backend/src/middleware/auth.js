// middleware/auth.js — verifies JWT on protected routes
const jwt = require("jsonwebtoken");

module.exports = function authMiddleware(req, res, next) {
  // Expect: Authorization: Bearer <token>
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = header.split(" ")[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, name, email }
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};
