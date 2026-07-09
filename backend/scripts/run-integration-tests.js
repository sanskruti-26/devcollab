// scripts/run-integration-tests.js
//
// Thin wrapper around `jest --config jest.integration.config.js` that turns
// "Jest silently produced no results" into a loud, unambiguous failure
// instead of a quiet green checkmark.
//
// Incident this exists to prevent: a CI run reported success, but its log
// showed the Docker build step and then nothing else — no "Fixture healthy",
// no PASS/FAIL lines, no "Test Suites:" summary. Whether that was a genuinely
// silent short-circuit or just a truncated log view, the underlying problem
// is the same either way: nothing was actually asserting that Jest collected
// and ran the tests we expect. A human skimming for a green checkmark can
// miss that. This script can't: it parses Jest's own --json output and hard-
// fails if the counts don't match what this suite is supposed to contain.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const OUTPUT_FILE = path.join(__dirname, "..", ".jest-integration-results.json");

// Bump these when you add/remove an integration test file or test() case —
// that's the point: this check is deliberately exact, not ">=", so a test
// that silently stops being collected trips it just as loudly as zero tests
// would.
const EXPECTED_SUITES = 4;
const EXPECTED_TESTS = 5;

function fail(message) {
  console.error(`\nFAIL (run-integration-tests): ${message}`);
  process.exit(1);
}

const result = spawnSync(
  "npx",
  ["jest", "--config", "jest.integration.config.js", "--runInBand", "--forceExit", "--json", `--outputFile=${OUTPUT_FILE}`],
  { stdio: "inherit", shell: true }
);

if (result.error) {
  fail(`could not even start Jest: ${result.error.message}`);
}

if (!fs.existsSync(OUTPUT_FILE)) {
  fail(
    "Jest produced no results file at all. It crashed or was killed before finishing " +
      "(e.g. globalSetup threw, or the process never got to run any tests) — " +
      `raw process exit code was ${result.status}.`
  );
}

let report;
try {
  report = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8"));
} catch (err) {
  fail(`Jest's results file exists but isn't valid JSON (${err.message}).`);
} finally {
  fs.rmSync(OUTPUT_FILE, { force: true });
}

const { numTotalTestSuites, numTotalTests, numPassedTests, numFailedTests, success } = report;

console.log(
  `\n[run-integration-tests] Collected ${numTotalTestSuites} suite(s), ${numTotalTests} test(s); ` +
    `${numPassedTests} passed, ${numFailedTests} failed.`
);

if (numTotalTestSuites === 0 || numTotalTests === 0) {
  fail(
    "Jest collected ZERO tests. This is always a bug — a broken testMatch pattern, a globalSetup " +
      "that swallowed an error, or similar — never a legitimate pass."
  );
}

if (numTotalTestSuites !== EXPECTED_SUITES || numTotalTests !== EXPECTED_TESTS) {
  fail(
    `expected ${EXPECTED_SUITES} suite(s) / ${EXPECTED_TESTS} test(s), got ${numTotalTestSuites} / ${numTotalTests}. ` +
      "A test file was skipped or not collected, or a new test was added without updating the " +
      "EXPECTED_SUITES/EXPECTED_TESTS constants at the top of this script."
  );
}

if (!success) {
  fail("one or more tests failed — see the Jest output above for which.");
}

console.log("[run-integration-tests] PASS — all expected suites and tests were collected and passed.\n");
process.exit(0);
