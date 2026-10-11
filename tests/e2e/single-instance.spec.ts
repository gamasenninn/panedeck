import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { launchApp, closeApp, APP_PATH } from "./helpers/electron-app";

/**
 * 2 つ目の PaneDeck は起動しない（2026-10-11）。
 *
 * 2 つ目は同じ設定を読むので、前回の構成を復元して同じ会話を二重に再開し、
 * 裏のコマンドもトリガーも二重に動く。2 つ目はすぐに終わり、1 つ目が前に出て知らせる。
 *
 * ★ 鍵は**設定の場所ごと**。全体の鍵にすると、E2E のアプリが開発者の動かしている
 * PaneDeck を「すでに動いている」と見て終わる。設定の場所が違えば並んで動けることは、
 * E2E 全体が開発者の PaneDeck の横で動くことで毎回確かめている
 */
test.describe.configure({ timeout: 60_000 });

const TEMP_DIR = path.join(__dirname, "temp-single-instance");
const SETTINGS_PATH = path.join(TEMP_DIR, "settings.json");
const FOLDER = path.join(TEMP_DIR, "work");
const OTHER = path.join(TEMP_DIR, "other");

let electronApp: ElectronApplication;
let page: Page;

/**
 * 同じ設定で 2 つ目を起動し、終わるまで待つ。終わり方（コード）を返す。
 * Playwright の launch は窓を待つので使わない（2 つ目は窓を出さずに終わる）
 */
function launchSecond(args: string[], settingsPath = SETTINGS_PATH): Promise<number | null> {
  const electronPath = require("electron") as unknown as string;
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [APP_PATH, ...args], {
      env: { ...process.env, PANEDECK_SETTINGS_PATH: settingsPath, PANEDECK_HIDE_WINDOW: "1" },
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("2 つ目が 15 秒たっても終わらない（起動してしまった）"));
    }, 15_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test.beforeEach(async () => {
  fs.mkdirSync(FOLDER, { recursive: true });
  fs.mkdirSync(OTHER, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ autoLog: false, autoRestore: false }), "utf8");
  ({ electronApp, page } = await launchApp({ settingsPath: SETTINGS_PATH, args: [FOLDER] }));
});

test.afterEach(async () => {
  if (electronApp) await closeApp(electronApp);
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

test("同じ設定で 2 つ目を起動すると、2 つ目はすぐに終わる", async () => {
  expect(await launchSecond([])).toBe(0);
  // 1 つ目は生きている
  await expect(page.getByTestId("add-session")).toBeVisible();
});

test("1 つ目に、2 つ目を起動しなかったことが出る", async () => {
  await launchSecond([]);
  await expect(page.getByTestId("message")).toHaveText(
    "PaneDeck はすでに動いています。2 つ目は起動しませんでした"
  );
});

test("2 つ目で別のフォルダを指定していたら、開いていないことが出る", async () => {
  await launchSecond([OTHER]);
  await expect(page.getByTestId("message")).toContainText(`${OTHER} は開いていません`);
  await expect(page.getByTestId("message")).toContainText(`いまは ${FOLDER}`);
});
