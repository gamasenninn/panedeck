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
  writtenTo,
  resetSessions,
  waitForPaneCount,
} from "./helpers/electron-app";

let electronApp: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  ({ electronApp, page } = await launchApp());
  await useFakePty(electronApp);
  // 状態は「最後の出力からの経過時間」で決まるため、時計を固定して決定的にする
  await useFakeClock(electronApp);
});

test.afterAll(async () => {
  await closeApp(electronApp);
});

const waitingOnly = () => page.locator("[data-testid=waiting-only]");
const target = () => page.locator("[data-testid=broadcast-target]");
const statusBadge = (i: number) => page.locator("[data-testid=pane-status]").nth(i);

async function typeAndSend(text: string) {
  await page.locator("[data-testid=broadcast-input]").fill(text);
  await page.locator("[data-testid=broadcast-send]").click();
}

/** 入力待ち / 待機 / 実行中 が 1 つずつ並んだデッキを用意する。 */
async function givenMixedDeck() {
  await resetSessions(electronApp, page);
  await waitingOnly().uncheck();

  for (let i = 0; i < 3; i++) {
    await createSession(page, { cwd: `C:\\app\\repo-${i}` });
  }
  await waitForPaneCount(page, 3);

  await advanceClock(electronApp, 1000);
  await emitPtyData(electronApp, 0, "╭────────╮\n│ >      │\n╰────────╯");
  await emitPtyData(electronApp, 1, "Done.");
  await advanceClock(electronApp, 1000);
  // 3 番目だけ直近に出力があるので実行中のまま
  await emitPtyData(electronApp, 2, "building...");

  await expect(statusBadge(0)).toHaveText("入力待ち");
  await expect(statusBadge(1)).toHaveText("待機");
  await expect(statusBadge(2)).toHaveText("実行中");
}

/** 入力待ちが 1 つも無いデッキを用意する。 */
async function givenNoWaitingDeck() {
  await resetSessions(electronApp, page);
  await waitingOnly().uncheck();

  for (let i = 0; i < 2; i++) {
    await createSession(page, { cwd: `C:\\app\\repo-${i}` });
  }
  await waitForPaneCount(page, 2);

  await advanceClock(electronApp, 1000);
  await emitPtyData(electronApp, 0, "Done.");
  await emitPtyExit(electronApp, 1, 0);
  await advanceClock(electronApp, 1000);

  await expect(statusBadge(0)).toHaveText("待機");
  await expect(statusBadge(1)).toHaveText("終了");
}

test("入力待ちのペインにだけ一斉送信する", async () => {
  await givenMixedDeck();
  await waitingOnly().check();
  await typeAndSend("続けて");

  expect(await writtenTo(electronApp, 0)).toEqual(["続けて\r"]);
  expect(await writtenTo(electronApp, 1)).toEqual([]);
  expect(await writtenTo(electronApp, 2)).toEqual([]);
});

test("チェックを外せば全ペインへ送る（既定の挙動は変えない）", async () => {
  await givenMixedDeck();
  await typeAndSend("全員へ");

  expect(await writtenTo(electronApp, 0)).toEqual(["全員へ\r"]);
  expect(await writtenTo(electronApp, 1)).toEqual(["全員へ\r"]);
  expect(await writtenTo(electronApp, 2)).toEqual(["全員へ\r"]);
});

test("送信先の表示が入力待ちの数になる", async () => {
  await givenMixedDeck();
  await expect(target()).toHaveText("送信先: 全 3 ペイン");

  await waitingOnly().check();
  await expect(target()).toHaveText("送信先: 入力待ち 1 ペイン");

  await waitingOnly().uncheck();
  await expect(target()).toHaveText("送信先: 全 3 ペイン");
});

test("選択と併用すると選択の中の入力待ちに絞られる", async () => {
  await givenMixedDeck();
  await waitingOnly().check();

  // 待機中のペインだけ選ぶ → 入力待ちは 0 件
  await page.locator("[data-testid=pane-select]").nth(1).check();
  await expect(target()).toHaveText("送信先: 選択のうち入力待ち 0 ペイン");

  // 入力待ちのペインも選ぶ → 1 件
  await page.locator("[data-testid=pane-select]").nth(0).check();
  await expect(target()).toHaveText("送信先: 選択のうち入力待ち 1 ペイン");

  await typeAndSend("選択かつ入力待ち");
  expect(await writtenTo(electronApp, 0)).toEqual(["選択かつ入力待ち\r"]);
  expect(await writtenTo(electronApp, 1)).toEqual([]);
  expect(await writtenTo(electronApp, 2)).toEqual([]);
});

test("状態が変わると送信先の数も追従する", async () => {
  await givenMixedDeck();
  await waitingOnly().check();
  await expect(target()).toHaveText("送信先: 入力待ち 1 ペイン");

  // 実行中だったペインが入力待ちで止まる
  await emitPtyData(electronApp, 2, "\n❯ 1. Yes\n  2. No");
  await advanceClock(electronApp, 1000);

  await expect(target()).toHaveText("送信先: 入力待ち 2 ペイン");
});

test.describe("該当が 0 件のとき", () => {
  test("何も送らず、その旨を知らせる", async () => {
    await givenNoWaitingDeck();
    await waitingOnly().check();
    await typeAndSend("届かない");

    await expect(page.locator("[data-testid=message]")).toContainText("入力待ち");
    expect(await writtenTo(electronApp, 0)).toEqual([]);
    expect(await writtenTo(electronApp, 1)).toEqual([]);
  });

  test("打ち直さずに済むよう入力欄は消さない", async () => {
    await givenNoWaitingDeck();
    await waitingOnly().check();
    await typeAndSend("消えないで");

    await expect(page.locator("[data-testid=broadcast-input]")).toHaveValue(
      "消えないで"
    );
  });
});

test.describe("特殊キー", () => {
  test("Enter も入力待ちのペインにだけ送られる", async () => {
    await givenMixedDeck();
    await waitingOnly().check();

    await page.locator("[data-testid=key-enter]").click();

    expect(await writtenTo(electronApp, 0)).toEqual(["\r"]);
    expect(await writtenTo(electronApp, 1)).toEqual([]);
    expect(await writtenTo(electronApp, 2)).toEqual([]);
  });

  test("該当が 0 件なら特殊キーも送らず知らせる", async () => {
    await givenNoWaitingDeck();
    await waitingOnly().check();

    await page.locator("[data-testid=key-esc]").click();

    await expect(page.locator("[data-testid=message]")).toContainText("入力待ち");
    expect(await writtenTo(electronApp, 0)).toEqual([]);
  });
});
