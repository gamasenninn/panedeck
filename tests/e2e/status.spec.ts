import { test, expect } from "@playwright/test";
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

let electronApp;
let page;

test.beforeAll(async () => {
  ({ electronApp, page } = await launchApp());
  await useFakePty(electronApp);
  // 状態は「最後の出力からの経過時間」で決まるため、時計を固定して決定的にする
  await useFakeClock(electronApp);
});

test.afterAll(async () => {
  await closeApp(electronApp);
});

const statusBadge = (index = 0) =>
  page.locator("[data-testid=pane-status]").nth(index);

async function givenPanes(n) {
  await resetSessions(electronApp, page);
  for (let i = 0; i < n; i++) {
    await createSession(page, { cwd: `C:\\app\\repo-${i}` });
  }
  await waitForPaneCount(page, n);
}

test("出力が流れている間は実行中", async () => {
  await givenPanes(1);
  await advanceClock(electronApp, 1000);
  await emitPtyData(electronApp, 0, "compiling module 3/10\n");

  await expect(statusBadge()).toHaveText("実行中");
});

test("出力が止まると待機になる", async () => {
  await givenPanes(1);
  await emitPtyData(electronApp, 0, "Done.\n");
  await advanceClock(electronApp, 1000);

  await expect(statusBadge()).toHaveText("待機");
});

test("Claude の入力ボックスで止まると入力待ちになる", async () => {
  await givenPanes(1);
  await emitPtyData(electronApp, 0, "╭────────╮\n│ >      │\n╰────────╯");
  await advanceClock(electronApp, 1000);

  await expect(statusBadge()).toHaveText("入力待ち");
});

test("選択肢プロンプトも入力待ちになる", async () => {
  await givenPanes(1);
  await emitPtyData(electronApp, 0, "Do you want to proceed?\n❯ 1. Yes\n  2. No");
  await advanceClock(electronApp, 1000);

  await expect(statusBadge()).toHaveText("入力待ち");
});

test("プロセスが終了すると終了になる", async () => {
  await givenPanes(1);
  await emitPtyExit(electronApp, 0, 0);

  await expect(statusBadge()).toHaveText("終了");
});

test("ペインごとに独立した状態を表示する", async () => {
  await givenPanes(3);
  await advanceClock(electronApp, 1000);

  await emitPtyData(electronApp, 0, "│ > ");
  await emitPtyData(electronApp, 1, "Done.");
  await emitPtyExit(electronApp, 2, 1);
  await advanceClock(electronApp, 1000);

  await expect(statusBadge(0)).toHaveText("入力待ち");
  await expect(statusBadge(1)).toHaveText("待機");
  await expect(statusBadge(2)).toHaveText("終了");
});

test("入力待ちのペインは running より優先して見分けられる", async () => {
  await givenPanes(2);
  await advanceClock(electronApp, 1000);

  await emitPtyData(electronApp, 0, "│ > ");
  await advanceClock(electronApp, 1000);
  // 1 番目だけ直近に出力があるので実行中のまま
  await emitPtyData(electronApp, 1, "still working...");

  await expect(statusBadge(0)).toHaveText("入力待ち");
  await expect(statusBadge(1)).toHaveText("実行中");
});
