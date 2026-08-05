import { test, expect } from "@playwright/test";
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
 * 端末は Ctrl+Enter と Enter を区別せず、どちらも CR (0x0D) を送る。
 * 受け取る側は同じバイトなので確定と解釈してしまう。
 * PaneDeck 側で改行として通る別のバイト列へ差し替えている。
 */

let electronApp;
let page;

test.beforeAll(async () => {
  ({ electronApp, page } = await launchApp());
  await useFakePty(electronApp);
});

test.afterAll(async () => {
  await closeApp(electronApp);
});

/** 直前の入力だけを見たいので、記録を空にしてからキーを押す */
async function pressAndCapture(combo: string): Promise<string> {
  await electronApp.evaluate(() => {
    global.__fakePtys.forEach((p: any) => (p.written.length = 0));
  });

  await page.keyboard.press(combo);

  await expect.poll(() => writtenTo(electronApp, 0)).not.toEqual([]);
  const written = await writtenTo(electronApp, 0);
  return written.join("");
}

async function givenFocusedPane() {
  await resetSessions(electronApp, page);
  await createSession(page, { cwd: "C:\\app\\repo-a" });
  await waitForPaneCount(page, 1);
  await page.locator(".pane .xterm-screen").click();
}

test("Ctrl+Enter は改行として送る", async () => {
  await givenFocusedPane();
  expect(await pressAndCapture("Control+Enter")).toBe("\x1b\r");
});

test("Shift+Enter も同じ", async () => {
  await givenFocusedPane();
  expect(await pressAndCapture("Shift+Enter")).toBe("\x1b\r");
});

test("修飾なしの Enter は従来どおり CR を送る", async () => {
  // ここを奪うと入力を確定できなくなる
  await givenFocusedPane();
  expect(await pressAndCapture("Enter")).toBe("\r");
});

test("Alt+Enter は元から改行なので変えない", async () => {
  await givenFocusedPane();
  expect(await pressAndCapture("Alt+Enter")).toBe("\x1b\r");
});

test("Ctrl+J（LF）も従来どおり通る", async () => {
  await givenFocusedPane();
  expect(await pressAndCapture("Control+J")).toBe("\n");
});

test("一斉入力の Enter ボタンは確定のまま", async () => {
  // ツールバーの Enter は「止まっているペインを進める」ためのもの。
  // 改行に変わっては困る
  await givenFocusedPane();
  await electronApp.evaluate(() => {
    global.__fakePtys.forEach((p: any) => (p.written.length = 0));
  });

  await page.locator("[data-testid=key-enter]").click();

  await expect.poll(() => writtenTo(electronApp, 0)).toEqual(["\r"]);
});
