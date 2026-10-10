import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import {
  launchApp,
  closeApp,
  useFakePty,
  createSession,
  emitPtyData,
  writtenTo,
  waitForPaneCount,
} from "./helpers/electron-app";

/**
 * ★ **溜まっていた問い合わせに、付き直したときに答えない**（2026-10-10、受付が見つけた）。
 *
 * 窓がペインに付くとき、溜まった出力（backlog）を xterm に流してから入力の受け口を
 * 付けていた。xterm の書き込みは非同期なので、backlog の中の問い合わせ（ESC[6n など）
 * への返事が、受け口を付けた**後に**出てきて、pty へ打ち込まれる。Mac の claude は
 * ESC[?6n を数百出していたので、付き直すたびに数百の返事が claude の入力欄へ流れ込む
 * ところだった。Windows でも起きる。
 *
 * その場の問い合わせに答えるのは正しい（端末の約束事）。答えないのは、溜まっていた
 * 古いものだけ。
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

/** カーソル位置の返事（ESC[行;列R / ESC[?行;列R） */
const REPLY = /\x1b\[\??\d+;\d+R/;

async function replies(): Promise<number> {
  return (await writtenTo(electronApp, 0)).filter((w) => REPLY.test(w)).length;
}

test("付き直しても、溜まっていた問い合わせには答えない", async () => {
  await createSession(page, { cwd: "/work/a", title: "a" });
  await waitForPaneCount(page, 1);

  // その場の問い合わせには答える（正しい動き）
  await emitPtyData(electronApp, 0, "\x1b[6n");
  await expect.poll(replies, { timeout: 10_000 }).toBe(1);

  // 窓を読み込み直す。ペインは付き直し、backlog（問い合わせを含む）が流し直される
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await waitForPaneCount(page, 1);
  await page.waitForTimeout(1000);

  expect(await replies()).toBe(1);
});
