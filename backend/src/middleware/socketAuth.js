// middleware/socketAuth.js — verifies JWT on the Socket.io handshake (io.use())
// Same secret + payload shape as middleware/auth.js, just on the WS transport
// instead of the Authorization header.
const jwt = require("jsonwebtoken");

module.exports = function socketAuthMiddleware(socket, next) {
  const token = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error("No token provided"));
  }

  try {
    socket.user = jwt.verify(token, process.env.JWT_SECRET); // { id, name, email }
    next();
  } catch {
    next(new Error("Invalid or expired token"));
  }
};
