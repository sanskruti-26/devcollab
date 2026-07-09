// tests/integration/globalSetup.js — runs once before the whole suite.
//
// Every step logs before AND after, and every failure is rethrown (never
// swallowed) — a prior CI run exited 0 with zero test output and no visible
// error, which made it impossible to tell whether docker-compose, backend1,
// or backend2 was the actual problem. If globalSetup throws here, Jest is
// expected to abort the whole run with a non-zero exit and print the thrown
// error; if that ever stops being true, that itself is worth knowing.
const { run, waitForHealth } = require("./helpers/docker");

module.exports = async function globalSetup() {
  console.log("\n[globalSetup] === STEP 1/3: docker compose up -d --build mongo redis backend1 backend2 ===");
  console.log(
    "[globalSetup] (mongo/redis have healthchecks in docker-compose.yml with depends_on: " +
      "service_healthy, so this command itself blocks until both are confirmed healthy before " +
      "backend1/backend2 are even started.)"
  );
  let buildOutput;
  try {
    buildOutput = run(["compose", "up", "-d", "--build", "mongo", "redis", "backend1", "backend2"]);
  } catch (err) {
    console.error("[globalSetup] STEP 1/3 FAILED — docker compose up threw:", err.message);
    throw err;
  }
  console.log(buildOutput);
  console.log("[globalSetup] STEP 1/3 complete — mongo/redis healthy, backend1/backend2 containers started.\n");

  console.log("[globalSetup] === STEP 2/3: waiting for backend1 and backend2 HTTP health endpoints ===");
  console.log(
    "[globalSetup] (containers being 'started' above doesn't mean the Node process inside has " +
      "finished booting and is actually listening yet — that's what this step confirms.)"
  );
  try {
    await waitForHealth("http://127.0.0.1:5001/health", "backend1");
  } catch (err) {
    console.error("[globalSetup] STEP 2/3 FAILED on backend1:", err.message);
    throw err;
  }
  try {
    await waitForHealth("http://127.0.0.1:5002/health", "backend2");
  } catch (err) {
    console.error("[globalSetup] STEP 2/3 FAILED on backend2:", err.message);
    throw err;
  }
  console.log("[globalSetup] STEP 2/3 complete — both backend instances are healthy.\n");

  console.log("[globalSetup] === STEP 3/3: fixture fully up — handing off to Jest to run tests ===\n");
};
