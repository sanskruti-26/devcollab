// tests/integration/globalSetup.js — runs once before the whole suite.
const { run, waitForHealth } = require("./helpers/docker");

module.exports = async function globalSetup() {
  console.log("\n[globalSetup] Bringing up docker-compose fixture (mongo, redis, backend1, backend2)...");
  console.log(run(["compose", "up", "-d", "--build", "mongo", "redis", "backend1", "backend2"]));
  await waitForHealth("http://127.0.0.1:5001/health");
  await waitForHealth("http://127.0.0.1:5002/health");
  console.log("[globalSetup] Fixture healthy.\n");
};
