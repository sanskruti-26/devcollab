// jest.integration.config.js — config for the multi-instance integration
// suite under tests/integration/. Separate from any future unit-test config
// since these tests need real docker-compose infrastructure, not mocks.
module.exports = {
  rootDir: __dirname,
  testMatch: ["<rootDir>/tests/integration/**/*.test.js"],
  globalSetup: "<rootDir>/tests/integration/globalSetup.js",
  globalTeardown: "<rootDir>/tests/integration/globalTeardown.js",
  testTimeout: 30000,
  // Tests share one live docker-compose fixture, and the reconnect-resync
  // suite restarts a container mid-run — files must execute serially, not in
  // parallel workers, or they'd step on each other's state.
  maxWorkers: 1,
};
