import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import {
  launchApp,
  closeApp,
  useFakePty,
  createSession,
  mockOpenDialog,
  resetSessions,
  waitForPaneCount,
  openSettings,
  closeSettings,
} from "./helpers/electron-app";

const TEMP_DIR = path.join(__dirname, "temp-settings-dialog");
const SETTINGS_PATH = path.join(TEMP_DIR, "settings.json");

let electronApp: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  ({ electronApp, page } = await launchApp({ settingsPath: SETTINGS_PATH }));
  await useFakePty(electronApp);
});

test.afterAll(async () => {
  await closeApp(electronApp);
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

const dialog = () => page.locator("[data-testid=settings-dialog]");
const saved = () => JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));

test.describe("ツールバーの整理", () => {
  test("設定へ移した項目はツールバーに出ていない", async () => {
    for (const id of ["font-size", "columns", "auto-restore", "auto-log"]) {
      await expect(page.locator(`#toolbar [data-testid=${id}]`)).toHaveCount(0);
    }
  });

  test("よく使うものはツールバーに残っている", async () => {
    // 次に追加するセッションの引数と、操作・状態表示
    for (const id of [
      "agent-select",
      "launch-command",
      "add-session",
      "save-workspace",
      "restore-workspace",
      "session-count",
      "close-all",
    ]) {
      await expect(page.locator(`#toolbar [data-testid=${id}]`)).toHaveCount(1);
    }
  });
});

test.describe("開閉", () => {
  test("既定では閉じている", async () => {
    await expect(dialog()).toBeHidden();
  });

  test("歯車で開き、閉じるボタンで閉じる", async () => {
    await openSettings(page);
    await expect(dialog()).toBeVisible();

    await closeSettings(page);
    await expect(dialog()).toBeHidden();
  });

  test("背景をクリックすると閉じる", async () => {
    await openSettings(page);
    await page.locator("[data-testid=settings-backdrop]").click({ position: { x: 5, y: 5 } });

    await expect(dialog()).toBeHidden();
  });

  test("中身をクリックしても閉じない", async () => {
    await openSettings(page);
    await page.locator("[data-testid=settings-dialog] h2").click();

    await expect(dialog()).toBeVisible();
    await closeSettings(page);
  });

  test("Esc で閉じる", async () => {
    await openSettings(page);
    await page.keyboard.press("Escape");

    await expect(dialog()).toBeHidden();
  });

  test("閉じているときの Esc は端末側に渡す", async () => {
    // ツールバーの Esc ボタン（一斉送信）と衝突させないこと。
    // ダイアログが閉じていれば Esc は何も横取りしない
    await resetSessions(electronApp, page);
    await createSession(page, { cwd: "C:\\app\\repo-a" });
    await waitForPaneCount(page, 1);

    await page.locator(".pane .xterm-screen").click();
    await page.keyboard.press("Escape");

    await expect(dialog()).toBeHidden();
  });
});

test.describe("表示の設定", () => {
  test("文字サイズを変えると端末に反映され、保存される", async () => {
    await resetSessions(electronApp, page);
    await createSession(page, { cwd: "C:\\app\\repo-a" });
    await waitForPaneCount(page, 1);

    await openSettings(page);
    await page.locator("[data-testid=font-size]").fill("19");
    await page.locator("[data-testid=font-size]").dispatchEvent("change");
    await closeSettings(page);

    await expect
      .poll(() =>
        page.evaluate(() =>
          parseFloat(
            getComputedStyle(document.querySelector(".pane .xterm-rows")!).fontSize
          )
        )
      )
      .toBe(19);
    await expect.poll(() => saved().fontSize).toBe(19);
  });

  test("列数を変えるとグリッドに反映され、保存される", async () => {
    await resetSessions(electronApp, page);
    for (const t of ["A", "B", "C", "D"]) {
      await createSession(page, { cwd: `C:\\app\\${t}`, title: t });
    }
    await waitForPaneCount(page, 4);

    await openSettings(page);
    await page.locator("[data-testid=columns]").selectOption("2");
    await closeSettings(page);

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            getComputedStyle(
              document.getElementById("grid")!
            ).gridTemplateColumns.split(" ").length
        )
      )
      .toBe(2);
    await expect.poll(() => saved().columns).toBe(2);

    await openSettings(page);
    await page.locator("[data-testid=columns]").selectOption("0");
    await closeSettings(page);
  });
});

test.describe("ログの設定", () => {
  test("UI の無かった項目を変えられる", async () => {
    await openSettings(page);

    await page.locator("[data-testid=log-retention-days]").fill("7");
    await page.locator("[data-testid=log-retention-days]").dispatchEvent("change");
    await page.locator("[data-testid=log-max-total-mb]").fill("100");
    await page.locator("[data-testid=log-max-total-mb]").dispatchEvent("change");
    await page.locator("[data-testid=log-strip-ansi]").uncheck();

    await closeSettings(page);

    await expect.poll(() => saved().logRetentionDays).toBe(7);
    await expect.poll(() => saved().logMaxTotalMB).toBe(100);
    await expect.poll(() => saved().logStripAnsi).toBe(false);
  });

  test("出力先をディレクトリ選択で決められる", async () => {
    const chosen = path.join(TEMP_DIR, "chosen-logs");
    await mockOpenDialog(electronApp, [chosen]);

    await openSettings(page);
    await page.locator("[data-testid=pick-log-dir]").click();

    await expect(page.locator("[data-testid=log-dir]")).toHaveValue(chosen);
    await expect.poll(() => saved().logDir).toBe(chosen);

    await closeSettings(page);
  });

  test("出力先を空に戻せる（既定の場所に戻る）", async () => {
    await openSettings(page);
    await page.locator("[data-testid=clear-log-dir]").click();

    await expect(page.locator("[data-testid=log-dir]")).toHaveValue("");
    await expect.poll(() => saved().logDir).toBe("");

    await closeSettings(page);
  });
});

test.describe("ログ自動保存の印", () => {
  test("有効なあいだツールバーに出る", async () => {
    await openSettings(page);
    await page.locator("[data-testid=auto-log]").check();
    await closeSettings(page);

    // 設定へ隠れても「書き続けている」ことは見えるようにする
    await expect(page.locator("[data-testid=auto-log-indicator]")).toBeVisible();
  });

  test("無効にすると消える", async () => {
    await openSettings(page);
    await page.locator("[data-testid=auto-log]").uncheck();
    await closeSettings(page);

    await expect(page.locator("[data-testid=auto-log-indicator]")).toBeHidden();
  });
});

test.describe("設定の保持", () => {
  test("開き直しても保存済みの値が出ている", async () => {
    await openSettings(page);
    await page.locator("[data-testid=auto-restore]").uncheck();
    await closeSettings(page);

    await openSettings(page);
    await expect(page.locator("[data-testid=auto-restore]")).not.toBeChecked();
    await expect(page.locator("[data-testid=log-retention-days]")).toHaveValue("7");

    await page.locator("[data-testid=auto-restore]").check();
    await closeSettings(page);
  });
});
