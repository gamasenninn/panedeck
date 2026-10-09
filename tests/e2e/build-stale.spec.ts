import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { launchApp, closeApp } from "./helpers/electron-app";

/**
 * **ビルドが新しくなったら、ツールバーで分かる**（2026-10-10）。
 *
 * 修正のたびに再起動して、新しいビルドで動いているかを道具で確かめる、を 1 日に
 * 10 回近くくり返した。画面で分かれば要らない。
 *
 * 見る場所は PANEDECK_BUILD_DIR で差し替える（本物の dist を書き換えない）。
 */
let electronApp: ElectronApplication;
let page: Page;
const BUILD = fs.mkdtempSync(path.join(os.tmpdir(), "panedeck-stale-"));

test.beforeAll(async () => {
  fs.writeFileSync(path.join(BUILD, "main.js"), "// v1", "utf8");
  process.env.PANEDECK_BUILD_DIR = BUILD;
  ({ electronApp, page } = await launchApp());
  delete process.env.PANEDECK_BUILD_DIR;
});

test.afterAll(async () => {
  await closeApp(electronApp);
  fs.rmSync(BUILD, { recursive: true, force: true });
});

test("起動したときのままなら出ない", async () => {
  await page.waitForTimeout(1500);
  await expect(page.locator("[data-testid=build-stale]")).toBeHidden();
});

test("ビルドの中身が変わったら、ツールバーに出る", async () => {
  fs.writeFileSync(path.join(BUILD, "main.js"), "// v2", "utf8");
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(BUILD, "main.js"), later, later);

  await expect(page.locator("[data-testid=build-stale]")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-testid=build-stale]")).toContainText("再起動");
});
