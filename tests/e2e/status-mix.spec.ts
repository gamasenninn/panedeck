import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import {
  launchApp,
  closeApp,
  useFakePty,
  useFakeClock,
  advanceClock,
  createSession,
  emitPtyData,
  emitPtyExit,
  resetSessions,
  waitForPaneCount,
} from "./helpers/electron-app";

/**
 * README の gif が主張していること —— **4 枚が別々の状態に落ち着く** —— を
 * 画面外で確かめる。
 *
 * ★ **なぜ収録と分けるか。** `tests/demo/record.spec.ts` は実寸のウィンドウを
 * 描いて録画するので、CI では読み込みが終わらない（実際に落ちた）。収録は
 * 手元のまま、**主張だけ**をここに置く。
 *
 * ★ **主張が無いと説明文は腐る。** #27 で「入力待ち」が 指示待ち / 確認待ち に
 * 分かれたのに、README の説明は「2 つのバッジが入力待ちに変わる」のまま
 * 2 か月放置された（2026-10-05 発見）。収録には主張が 2 つ（拡大の枚数）しか
 * 無かったので、映っているものが変わっても通り続けた。
 */

let electronApp: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  ({ electronApp, page } = await launchApp());
  await useFakePty(electronApp);
  await useFakeClock(electronApp);
});

test.afterAll(async () => {
  await closeApp(electronApp);
});

const badge = (i: number) => page.locator("[data-testid=pane-status]").nth(i);

test("4 枚が別々の状態に落ち着く（gif が主張している形）", async () => {
  await resetSessions(electronApp, page);

  // gif と同じ並び（tests/demo/record.spec.ts の SESSIONS）
  for (const s of [
    { title: "api-server", cwd: "C:\\work\\api-server", agent: "claude" },
    { title: "web-client", cwd: "C:\\work\\web-client", agent: "codex" },
    { title: "docs-site", cwd: "C:\\work\\docs-site", agent: "claude" },
    { title: "infra", cwd: "C:\\work\\infra", agent: "shell" },
  ]) {
    await createSession(page, s);
  }
  await waitForPaneCount(page, 4);
  await advanceClock(electronApp, 1000);

  // api-server: 確認の問い。claude は分けられる
  await emitPtyData(electronApp, 0, "\r\nApply this change? [y/n] ");
  // web-client: 働き続けている（静かになったら「待機」）
  await emitPtyData(electronApp, 1, "  updating imports\r\n");
  // docs-site: 選択肢。❯ だけでは入力欄かダイアログか決められない
  await emitPtyData(electronApp, 2, "\r\n  \u276f concise\r\n    detailed\r\n");
  // infra: 終わる
  await emitPtyData(electronApp, 3, "  plan is clean\r\n");
  await emitPtyExit(electronApp, 3, 0);

  await advanceClock(electronApp, 1000);

  await expect(badge(0)).toHaveText("確認待ち");
  await expect(badge(1)).toHaveText("待機");
  await expect(badge(2)).toHaveText("入力待ち");
  await expect(badge(3)).toHaveText("終了");
});

/**
 * **Enter は待っているペインにだけ届く**（gif の中心の動き）。
 *
 * テキストは `指示待ち` だけへ送るが、Enter のような進めるキーは
 * `確認待ち` と `入力待ち` にも届く —— 止まっているものを進めるのが
 * この機能の主用途なので（#25 / #27）。
 */
test("Enter は待っている 2 枚にだけ届く", async () => {
  await page.locator("[data-testid=waiting-only]").check();
  await page.locator("[data-testid=key-enter]").click();

  const written = await electronApp.evaluate(() =>
    global.__fakePtys.map((p: { written: string[] }) => p.written.join(""))
  );

  expect(written[0]).toContain("\r"); // 確認待ち
  expect(written[2]).toContain("\r"); // 入力待ち
  expect(written[1]).toBe(""); // 待機には届かない
  expect(written[3]).toBe(""); // 終了にも届かない

  await page.locator("[data-testid=waiting-only]").uncheck();
});
