// metrics.js — Prometheus metrics, scraped via GET /metrics (wired in server.js)
//
// Own Registry (not prom-client's global default) so this module can be
// required multiple times in tests without "metric already registered" errors.
const client = require("prom-client");

const register = new client.Registry();

// Set once from server.js after Socket.io is created. The two gauges below
// read Socket.io's own state at scrape time instead of being kept in sync by
// hand on every join/leave.
let ioRef = null;
function setIo(io) {
  ioRef = io;
}

// Socket.io auto-joins every socket to a private room named after its own
// socket id — excluding those (via io.sockets.sockets.has) leaves only the
// rooms code actually joined via socket.join(roomId) in roomService.js.
// Per-instance count, same as connectedSockets below: each backend behind
// nginx exposes its own /metrics, so multi-instance totals are a Prometheus
// sum() across targets, not something computed here.
new client.Gauge({
  name: "devcollab_active_rooms",
  help: "Rooms with at least one connected socket on this instance",
  registers: [register],
  collect() {
    if (!ioRef) return this.set(0);
    let count = 0;
    for (const room of ioRef.sockets.adapter.rooms.keys()) {
      if (!ioRef.sockets.sockets.has(room)) count++;
    }
    this.set(count);
  },
});

new client.Gauge({
  name: "devcollab_connected_sockets",
  help: "Currently connected Socket.io clients on this instance",
  registers: [register],
  collect() {
    this.set(ioRef ? ioRef.engine.clientsCount : 0);
  },
});

// Counters, not a hand-computed rate — Grafana/Prometheus derive "per second"
// from a counter via rate(devcollab_yjs_updates_total[1m]), which is the
// standard way to chart this and avoids duplicating that math here.
const yjsUpdatesTotal = new client.Counter({
  name: "devcollab_yjs_updates_total",
  help: "Total Yjs updates processed (rate() this for updates/sec)",
  registers: [register],
});

const judge0ExecutionsTotal = new client.Counter({
  name: "devcollab_judge0_executions_total",
  help: "Total code execution requests sent to Judge0",
  registers: [register],
});

module.exports = { register, setIo, yjsUpdatesTotal, judge0ExecutionsTotal };
