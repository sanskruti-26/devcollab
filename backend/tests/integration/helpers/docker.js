// tests/integration/helpers/docker.js
//
// Thin wrappers around the docker-compose.yml fixture used by this suite —
// deliberately no separate test infrastructure, just the same containers
// scripts/verify-multi-instance-race.js and manual testing already use.
//
// Uses spawnSync with an argument array (never a single command string
// through execSync) — routing a quoted absolute docker.exe path through
// cmd.exe's own string reparsing proved unreliable on this host (the compose
// plugin intermittently wasn't found). spawnSync with argv avoids shell
// reparsing entirely and just execs "docker" via Node's own PATH resolution,
// which has been reliable throughout this session.

const { spawnSync } = require("child_process");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "../../../..");

// Synchronous sleep (no async propagation needed through run()'s callers).
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Retries on failure — Docker Desktop on this host has intermittently thrown
// spurious CLI errors under concurrent load (e.g. right after a container
// restart) that don't reproduce when the exact same command is re-run a
// moment later. A couple of quick retries absorbs that without masking a
// genuinely broken command, which still fails after exhausting them.
function run(args, attempts = 3) {
  let lastResult;
  for (let i = 0; i < attempts; i++) {
    const result = spawnSync("docker", args, { cwd: REPO_ROOT, encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status === 0) return result.stdout;
    lastResult = result;
    if (i < attempts - 1) sleepSync(500);
  }
  throw new Error(
    `docker ${args.join(" ")} failed (exit ${lastResult.status}) after ${attempts} attempts:\n${lastResult.stdout}\n${lastResult.stderr}`
  );
}

// Polls `url` until it responds 2xx, or throws. Logs progress every ~5s (not
// every 1s attempt — that would flood the log) specifically so a genuine
// HANG is visibly distinguishable in CI from a fast, silent failure: if this
// never prints even its first "polling..." line, the process died or
// stalled before reaching this call at all, which is a different bug than a
// slow-to-boot container.
async function waitForHealth(url, label, timeoutMs = 60000) {
  const start = Date.now();
  let lastErr;
  let attempt = 0;
  console.log(`[waitForHealth] ${label}: polling ${url} (timeout ${timeoutMs}ms)...`);
  while (Date.now() - start < timeoutMs) {
    attempt++;
    try {
      const res = await fetch(url);
      if (res.ok) {
        console.log(`[waitForHealth] ${label}: healthy after ${Date.now() - start}ms (attempt ${attempt}).`);
        return;
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    const elapsed = Date.now() - start;
    if (elapsed > 0 && elapsed % 5000 < 1000) {
      console.log(`[waitForHealth] ${label}: still waiting after ${elapsed}ms (last error: ${lastErr?.message})...`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `[waitForHealth] ${label}: TIMED OUT after ${timeoutMs}ms waiting for ${url} to become healthy. ` +
      `Last error: ${lastErr?.message ?? "(none — never got a response at all)"}`
  );
}

// Restarts a single service container in place (same image, same port
// mapping) — used by the reconnect/resync tests to force that service's
// in-memory ydocs Map to reset, so the next access must cold-start-hydrate
// from Redis/Mongo instead of serving from warm memory.
function restartService(serviceName) {
  run(["compose", "restart", serviceName]);
}

// Runs a command inside a running compose service container and returns
// trimmed stdout — used to reach redis-cli inside the redis container, which
// (deliberately) has no host-published port in docker-compose.yml.
function composeExec(service, cmdArgs) {
  return run(["compose", "exec", "-T", service, ...cmdArgs]).trim();
}

module.exports = { run, waitForHealth, restartService, composeExec, REPO_ROOT };
