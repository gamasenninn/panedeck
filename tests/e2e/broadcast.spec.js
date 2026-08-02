const { test, expect } = require("@playwright/test");
const {
  launchApp,
  closeApp,
  useFakePty,
  createSession,
  emitPtyExit,
  writtenTo,
  resetSessions,
  waitForPaneCount,
} = require("./helpers/electron-app");

let electronApp;
let page;

test.beforeAll(async () => {
  ({ electronApp, page } = await launchApp());
  await useFakePty(electronApp);
});

test.afterAll(async () => {
  await closeApp(electronApp);
});

/** ペインを n 個そろえる（起動コマンドは流さない） */
async function givenPanes(n) {
  await resetSessions(electronApp, page);
  for (let i = 0; i < n; i++) {
    await createSession(page, { cwd: `C:\\app\\repo-${i}` });
  }
  await waitForPaneCount(page, n);
}

async function typeAndSend(text) {
  await page.locator("[data-testid=broadcast-input]").fill(text);
  await page.locator("[data-testid=broadcast-send]").click();
}

test("未選択なら全ペインへ一斉送信する", async () => {
  await givenPanes(3);
  await typeAndSend("npm test");

  for (let i = 0; i < 3; i++) {
    expect(await writtenTo(electronApp, i)).toEqual(["npm test\r"]);
  }
});

test("送信後に入力欄がクリアされる", async () => {
  await givenPanes(1);
  await typeAndSend("hello");

  await expect(page.locator("[data-testid=broadcast-input]")).toHaveValue("");
});

test("チェックしたペインにだけ送信する", async () => {
  await givenPanes(3);
  await page.locator("[data-testid=pane-select]").nth(0).check();
  await page.locator("[data-testid=pane-select]").nth(2).check();

  await typeAndSend("only selected");

  expect(await writtenTo(electronApp, 0)).toEqual(["only selected\r"]);
  expect(await writtenTo(electronApp, 1)).toEqual([]);
  expect(await writtenTo(electronApp, 2)).toEqual(["only selected\r"]);
});

test("送信先の表示が選択状態に追従する", async () => {
  await givenPanes(3);
  await expect(page.locator("[data-testid=broadcast-target]")).toHaveText(
    "送信先: 全 3 ペイン"
  );

  await page.locator("[data-testid=pane-select]").nth(1).check();
  await expect(page.locator("[data-testid=broadcast-target]")).toHaveText(
    "送信先: 選択 1 ペイン"
  );

  await page.locator("[data-testid=pane-select]").nth(1).uncheck();
  await expect(page.locator("[data-testid=broadcast-target]")).toHaveText(
    "送信先: 全 3 ペイン"
  );
});

test("空入力では何も送信しない", async () => {
  await givenPanes(2);
  await typeAndSend("");

  expect(await writtenTo(electronApp, 0)).toEqual([]);
  expect(await writtenTo(electronApp, 1)).toEqual([]);
});

test("入力欄で Enter を押しても送信できる", async () => {
  await givenPanes(2);
  await page.locator("[data-testid=broadcast-input]").fill("via enter key");
  await page.locator("[data-testid=broadcast-input]").press("Enter");

  await expect(page.locator("[data-testid=broadcast-input]")).toHaveValue("");
  expect(await writtenTo(electronApp, 0)).toEqual(["via enter key\r"]);
  expect(await writtenTo(electronApp, 1)).toEqual(["via enter key\r"]);
});

test("終了済みセッションには送信しない", async () => {
  await givenPanes(2);
  await emitPtyExit(electronApp, 0, 0);

  await typeAndSend("after exit");

  expect(await writtenTo(electronApp, 0)).toEqual([]);
  expect(await writtenTo(electronApp, 1)).toEqual(["after exit\r"]);
});

test.describe("特殊キーの送信", () => {
  const CASES = [
    { testid: "key-enter", sequence: "\r", label: "Enter" },
    { testid: "key-esc", sequence: "\x1b", label: "Esc" },
    { testid: "key-ctrl-c", sequence: "\x03", label: "Ctrl+C" },
    { testid: "key-up", sequence: "\x1b[A", label: "↑" },
    { testid: "key-down", sequence: "\x1b[B", label: "↓" },
  ];

  for (const { testid, sequence, label } of CASES) {
    test(`${label} が全ペインへ送られる`, async () => {
      await givenPanes(2);
      await page.locator(`[data-testid=${testid}]`).click();

      expect(await writtenTo(electronApp, 0)).toEqual([sequence]);
      expect(await writtenTo(electronApp, 1)).toEqual([sequence]);
    });
  }

  test("選択中のペインにだけ特殊キーを送れる", async () => {
    await givenPanes(3);
    await page.locator("[data-testid=pane-select]").nth(1).check();

    await page.locator("[data-testid=key-esc]").click();

    expect(await writtenTo(electronApp, 0)).toEqual([]);
    expect(await writtenTo(electronApp, 1)).toEqual(["\x1b"]);
    expect(await writtenTo(electronApp, 2)).toEqual([]);
  });
});
