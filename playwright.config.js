// @ts-check
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  workers: 1,
  timeout: 30000,
  expect: {
    timeout: 10000,
  },
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  projects: [
    { name: "unit", testDir: "./tests/unit" },
    { name: "e2e", testDir: "./tests/e2e" },
  ],
});
