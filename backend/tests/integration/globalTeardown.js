// tests/integration/globalTeardown.js — runs once after the whole suite.
const { run } = require("./helpers/docker");

module.exports = async function globalTeardown() {
  console.log("\n[globalTeardown] Tearing down docker-compose fixture...");
  console.log(run(["compose", "down"]));
};
