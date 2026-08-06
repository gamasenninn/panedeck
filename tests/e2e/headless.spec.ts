import { test, expect } from "@playwright/test";
import {
  launchApp,
  closeApp,
  useFakePty,
  createSession,
  emitPtyData,
  resetSessions,
  waitForPaneCount,
} from "./helpers/electron-app";

/**
 * Electron には Chromium のような真のヘッドレスが無い。E2E ではウィンドウを
 * **画面の外へ置く**（隠すのではない）。
 *
 * `show: false` でも目には触れないが、Chromium がフレームを作らなくなり
 * Playwright の安定性チェックが毎回待たされる。1 スイート 9 秒が 59 秒に
 * なり、全体では 2.3 分が 11.6 分に膨らんだ。省電力系のスイッチを切っても
 * 変わらなかった。画面外なら描画は続くので、速度を落とさずに済む。
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

test("テスト中はウィンドウが画面の外にある", async () => {
  const bounds = await electronApp.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0].getBounds();
    const displays = screen.getAllDisplays().map((d) => d.bounds);
    return { win, displays };
  });

  // どのディスプレイとも重ならない位置にあること
  const overlaps = bounds.displays.some(
    (d) =>
      bounds.win.x < d.x + d.width &&
      bounds.win.x + bounds.win.width > d.x &&
      bounds.win.y < d.y + d.height &&
      bounds.win.y + bounds.win.height > d.y
  );
  expect(overlaps).toBe(false);
});

test("Chromium からは見えている（描画が止まらない）", async () => {
  // ここが false になると描画が抑制され、E2E が桁違いに遅くなる。
  // 「目に触れない」ことと「Chromium が描画を続ける」ことを両立させている
  const visible = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => w.isVisible())
  );

  expect(visible).toEqual([true]);
});

test("画面外でも描画と操作はできる", async () => {
  await resetSessions(electronApp, page);
  await createSession(page, { cwd: "C:\\app\\repo-a", title: "hidden" });
  await waitForPaneCount(page, 1);

  await emitPtyData(electronApp, 0, "rendered while hidden\n");
  await expect(page.locator(".pane")).toContainText("rendered while hidden");
  await expect(page.locator("[data-testid=pane-title]")).toHaveText("hidden");
});

test("背景に回してもタイマーが止まらない", async () => {
  // 状態の追従は 300ms ポーリングに乗っている。他の作業をしている間に
  // 間引かれると、どのペインが止まっているか分からなくなる
  // （webPreferences.backgroundThrottling: false）
  await resetSessions(electronApp, page);
  await createSession(page, { cwd: "C:\\app\\repo-a" });

  // ポーリングで拾われてペインが増えることが、タイマーが動いている証拠
  await waitForPaneCount(page, 1);

  await createSession(page, { cwd: "C:\\app\\repo-b" });
  await waitForPaneCount(page, 2);
});
