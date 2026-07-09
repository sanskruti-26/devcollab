// tests/integration/helpers/redis.js
//
// Redis has no host-published port in docker-compose.yml — only backend1/
// backend2 need it, over the compose network — so these helpers reach it via
// `redis-cli` INSIDE the redis container (docker compose exec) rather than a
// host-side Redis client.

const { composeExec } = require("./docker");

function redisGet(key) {
  const out = composeExec("redis", ["redis-cli", "GET", key]);
  // redis-cli prints "(nil)" in its interactive REPL, but through
  // `docker compose exec` (no TTY) a missing key just comes back empty.
  return out === "(nil)" || out === "" ? null : out;
}

function redisDel(key) {
  composeExec("redis", ["redis-cli", "DEL", key]);
}

module.exports = { redisGet, redisDel };
