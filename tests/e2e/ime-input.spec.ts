import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import {
  launchApp,
  closeApp,
  useFakePty,
  createSession,
  writtenTo,
  resetSessions,
  waitForPaneCount,
} from "./helpers/electron-app";

/**
 * IME で確定した文字が pty まで無傷で届くかを見る。
 *
 * `insertText` はキーイベントを伴わずに文字列を差し込むので、IME の確定と
 * 同じ経路（xterm の composition → onData）を通る。ここが通っていれば
 * PaneDeck 側の受け渡しは正しく、あとは受け取る側の問題になる。
 */

let electronApp: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  ({ electronApp, page } = await launchApp());
  await useFakePty(electronApp);
});

test.afterAll(async () => {
  await closeApp(electronApp);
});

async function givenFocusedPane() {
  await resetSessions(electronApp, page);
  await createSession(page, { cwd: "C:\\app\\repo-a" });
  await waitForPaneCount(page, 1);
  await page.locator(".pane .xterm-screen").click();
}

test("漢字を確定すると、そのまま pty へ届く", async () => {
  await givenFocusedPane();

  await page.keyboard.insertText("漢字入力");

  await expect
    .poll(() => writtenTo(electronApp, 0).then((w) => w.join("")))
    .toBe("漢字入力");
});

test("ひらがな・カタカナ・絵文字も欠けない", async () => {
  await givenFocusedPane();

  await page.keyboard.insertText("あいうカキク🙂");

  await expect
    .poll(() => writtenTo(electronApp, 0).then((w) => w.join("")))
    .toBe("あいうカキク🙂");
});

test("英数字と混ざっていても順序が保たれる", async () => {
  await givenFocusedPane();

  await page.keyboard.insertText("abc漢字123かな");

  await expect
    .poll(() => writtenTo(electronApp, 0).then((w) => w.join("")))
    .toBe("abc漢字123かな");
});

test("続けて確定しても取りこぼさない", async () => {
  await givenFocusedPane();

  await page.keyboard.insertText("一回目");
  await page.keyboard.insertText("二回目");

  await expect
    .poll(() => writtenTo(electronApp, 0).then((w) => w.join("")))
    .toBe("一回目二回目");
});

test("一斉入力でも多バイト文字が届く", async () => {
  await resetSessions(electronApp, page);
  await createSession(page, { cwd: "C:\\app\\repo-a" });
  await createSession(page, { cwd: "C:\\app\\repo-b" });
  await waitForPaneCount(page, 2);

  await page.locator("[data-testid=broadcast-input]").fill("日本語で指示");
  await page.locator("[data-testid=broadcast-send]").click();

  for (const i of [0, 1]) {
    await expect
      .poll(() => writtenTo(electronApp, i).then((w) => w.join("")))
      .toBe("日本語で指示\r");
  }
});
