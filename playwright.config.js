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
    // パッケージ版の生成物が要るので既定の実行には含めない（npm run test:packaged）
    { name: "packaged", testDir: "./tests/packaged" },
    // README 用のデモ収録。検証ではないので既定の実行には含めない（npm run demo）。
    // 尺のぶんだけ時間がかかるので、この枠だけ待ち時間を延ばす
    { name: "demo", testDir: "./tests/demo", timeout: 180000 },
  ],
});
