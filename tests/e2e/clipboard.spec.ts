import { test, expect } from "@playwright/test";
import {
  launchApp,
  closeApp,
  useFakePty,
  createSession,
  emitPtyData,
  writtenTo,
  resetSessions,
  waitForPaneCount,
} from "./helpers/electron-app";

let electronApp;
let page;

test.beforeAll(async () => {
  ({ electronApp, page } = await launchApp());
  await useFakePty(electronApp);
});

test.afterAll(async () => {
  await closeApp(electronApp);
});

/** メインプロセスのクリップボードを読む */
function clipboardText(): Promise<string> {
  return electronApp.evaluate(({ clipboard }) => clipboard.readText());
}

async function setClipboard(text: string) {
  await electronApp.evaluate(
    ({ clipboard }, t) => clipboard.writeText(t),
    text
  );
}

/** 1 ペイン用意して、選択できる出力を流す */
async function givenPaneWithOutput(text: string) {
  await resetSessions(electronApp, page);
  await createSession(page, { cwd: "C:\\app\\repo-a" });
  await waitForPaneCount(page, 1);
  await emitPtyData(electronApp, 0, text);

  // 端末に描画されるまで待つ
  await expect(page.locator(".pane .xterm-rows")).toContainText(text.trim());
}

/**
 * 出力のある 1 行目をトリプルクリックして選択する。
 *
 * 座標で指定する理由が 2 つある。既定の中央クリックは空行に当たり、空行でも
 * `hasSelection()` は true になるが `getSelection()` は空文字列なのでコピーの
 * 検証にならない。かといって行の要素（`.xterm-rows > div`）は
 * `pointer-events` を受けない層にあり、クリックできない。
 *
 * 端末の左上（1 行目の中）を狙う。
 */
async function selectLine() {
  await page
    .locator(".pane .xterm-screen")
    .click({ clickCount: 3, position: { x: 30, y: 5 } });
}

test("選択して Ctrl+Shift+C でコピーできる", async () => {
  await setClipboard("(前の内容)");
  await givenPaneWithOutput("copy-me-please\n");

  await selectLine();
  await page.keyboard.press("Control+Shift+C");

  await expect.poll(clipboardText).toContain("copy-me-please");
});

test("選択があるときの Ctrl+C はコピーになり、pty へ中断を送らない", async () => {
  await setClipboard("(前の内容)");
  await givenPaneWithOutput("interrupt-or-copy\n");

  await selectLine();
  await page.keyboard.press("Control+C");

  await expect.poll(clipboardText).toContain("interrupt-or-copy");
  // \x03 が飛んでいないこと
  expect((await writtenTo(electronApp, 0)).join("")).not.toContain("\x03");
});

test("選択が無ければ Ctrl+C は中断として pty へ届く", async () => {
  // ここを奪うと実行中のコマンドを止められなくなる
  await givenPaneWithOutput("nothing-selected\n");
  await page.locator(".pane .xterm-screen").click();

  await page.keyboard.press("Control+C");

  await expect
    .poll(() => writtenTo(electronApp, 0).then((w) => w.join("")))
    .toContain("\x03");
});

test("コピー後は選択が解除される（次の Ctrl+C が中断に戻る）", async () => {
  await givenPaneWithOutput("select-then-interrupt\n");

  await selectLine();
  await page.keyboard.press("Control+C");
  await expect.poll(clipboardText).toContain("select-then-interrupt");

  // 2 回目は選択が無いので中断になる
  await page.keyboard.press("Control+C");
  await expect
    .poll(() => writtenTo(electronApp, 0).then((w) => w.join("")))
    .toContain("\x03");
});

test("コピーしたことを知らせる", async () => {
  await givenPaneWithOutput("notify-me\n");

  await selectLine();
  await page.keyboard.press("Control+Shift+C");

  await expect(page.locator("[data-testid=message]")).toContainText("コピー");
});
