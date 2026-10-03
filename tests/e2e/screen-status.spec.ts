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
  resetSessions,
  waitForPaneCount,
} from "./helpers/electron-app";

/**
 * 判定が画面を見ていることを、アプリ全体で確かめる（#31）。
 *
 * 記録の末尾を見ていた頃は、**画面に出ているのに窓から落ちた**印を拾えず、
 * 仕事を終えたペインが指示待ちに戻らなかった。実測で、入力欄の印が
 * 2000 文字の窓の 8 倍以上手前にあった。
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

const statusBadge = () => page.locator("[data-testid=pane-status]").first();

async function givenPane() {
  await resetSessions(electronApp, page);
  await createSession(page, { cwd: "/work/repo-a", cols: 60, rows: 12 });
  await waitForPaneCount(page, 1);
  await advanceClock(electronApp, 1000);
}

/**
 * 下の行にフッターを描いてから、上の行だけを塗り替え続ける。
 * 記録の末尾は上の行で埋まるが、画面にはフッターが残る。
 */
test("塗り替えで記録の末尾から落ちても、指示待ちと分かる", async () => {
  await givenPane();

  await emitPtyData(electronApp, 0, "\x1b[12;1H⏸ manual mode on · ? for shortcuts");
  for (let i = 0; i < 60; i++) {
    await emitPtyData(electronApp, 0, `\x1b[1;1H作業中 ${i} ..........................`);
  }
  await advanceClock(electronApp, 1000);

  await expect(statusBadge()).toHaveText("指示待ち");
});

/** 答えて画面から消えたダイアログに、いつまでも引きずられない */
test("ダイアログを消せば確認待ちから戻る", async () => {
  await givenPane();

  await emitPtyData(electronApp, 0, "Do you want to create note.txt?\r\n❯ 1 Yes\r\n  3. No");
  await advanceClock(electronApp, 1000);
  await expect(statusBadge()).toHaveText("確認待ち");

  // 画面を消して入力欄を描き直す（答えた後の動き）
  await emitPtyData(electronApp, 0, "\x1b[2J\x1b[H❯\r\n⏸ manual mode on");
  await advanceClock(electronApp, 1000);

  await expect(statusBadge()).toHaveText("指示待ち");
});

/** 画面の外へ流れた古い出力に引きずられない */
test("流れ去った古い出力は判定に影響しない", async () => {
  await givenPane();

  await emitPtyData(electronApp, 0, "Do you want to proceed?\r\n");
  // 画面の高さを超える出力で押し流す
  for (let i = 0; i < 30; i++) {
    await emitPtyData(electronApp, 0, `行 ${i}\r\n`);
  }
  await emitPtyData(electronApp, 0, "❯\r\n⏸ manual mode on");
  await advanceClock(electronApp, 1000);

  await expect(statusBadge()).toHaveText("指示待ち");
});
