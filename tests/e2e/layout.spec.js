const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const {
  launchApp,
  closeApp,
  useFakePty,
  createSession,
  emitPtyData,
  writtenTo,
  listSessions,
  mockOpenDialog,
  mockSaveDialog,
  resetSessions,
  waitForPaneCount,
} = require("./helpers/electron-app");

const TEMP_DIR = path.join(__dirname, "temp-layout");
const SETTINGS_PATH = path.join(TEMP_DIR, "settings.json");

let electronApp;
let page;

test.beforeAll(async () => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  ({ electronApp, page } = await launchApp({ settingsPath: SETTINGS_PATH }));
  await useFakePty(electronApp);
});

test.afterAll(async () => {
  await closeApp(electronApp);
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

const paneTitles = () => page.locator("[data-testid=pane-title]");
const columnsSelect = () => page.locator("[data-testid=columns]");

/** メインプロセス側の並び順 */
async function orderInMain() {
  return (await listSessions(electronApp)).map((s) => s.title);
}

async function givenPanes(titles) {
  await resetSessions(electronApp, page);
  for (const title of titles) {
    await createSession(page, { cwd: `C:\\app\\${title}`, title });
  }
  await waitForPaneCount(page, titles.length);
}

/** レンダラ経由で並べ替える（D&D の結果として起きることと同じ） */
async function reorderTo(titles) {
  await page.evaluate(async (wanted) => {
    // @ts-ignore renderer.js 最上位の const
    const byTitle = new Map([...panes.values()].map((p) => [p.titleEl.textContent, p.id]));
    await window.deck.reorderSessions(wanted.map((t) => byTitle.get(t)));
  }, titles);
}

test("並べ替えるとペインの順が変わる", async () => {
  await givenPanes(["A", "B", "C"]);
  await expect(paneTitles()).toHaveText(["A", "B", "C"]);

  await reorderTo(["C", "A", "B"]);

  await expect(paneTitles()).toHaveText(["C", "A", "B"]);
  expect(await orderInMain()).toEqual(["C", "A", "B"]);
});

test("ヘッダを掴んでドラッグすると並べ替えられる", async () => {
  await givenPanes(["A", "B", "C"]);

  // C のヘッダを A の左半分へ落とす
  const source = page.locator(".pane").nth(2).locator(".pane-header");
  const target = page.locator(".pane").nth(0);
  const box = await target.boundingBox();
  await source.dragTo(target, {
    targetPosition: { x: box.width * 0.2, y: box.height * 0.1 },
  });

  await expect(paneTitles()).toHaveText(["C", "A", "B"]);
  expect(await orderInMain()).toEqual(["C", "A", "B"]);
});

test("端末の上ではドラッグを始めない（文字選択の邪魔をしない）", async () => {
  await givenPanes(["A", "B"]);

  const body = page.locator(".pane").nth(0).locator(".pane-body");
  expect(await body.evaluate((el) => el.draggable)).toBe(false);

  const header = page.locator(".pane").nth(0).locator(".pane-header");
  expect(await header.evaluate((el) => el.draggable)).toBe(true);
});

test("ポーリングで並びが元に戻らない", async () => {
  await givenPanes(["A", "B", "C"]);
  await reorderTo(["C", "B", "A"]);
  await expect(paneTitles()).toHaveText(["C", "B", "A"]);

  // 同期が何周かするあいだ、並びが保たれること
  for (let i = 0; i < 3; i++) {
    await expect(paneTitles()).toHaveText(["C", "B", "A"]);
  }
});

test("並べ替えても pty との接続が切れない", async () => {
  await givenPanes(["A", "B"]);
  await emitPtyData(electronApp, 0, "before reorder\n");

  await reorderTo(["B", "A"]);
  await expect(paneTitles()).toHaveText(["B", "A"]);

  // 端末が作り直されていなければ、並べ替え前の出力が残っている
  await expect(page.locator(".pane").nth(1)).toContainText("before reorder");

  // 書き込みも従来どおり届く
  await page.locator("[data-testid=broadcast-input]").fill("still connected");
  await page.locator("[data-testid=broadcast-send]").click();
  await expect
    .poll(() => writtenTo(electronApp, 0))
    .toEqual(["still connected\r"]);
});

test("並べ替えた後に増えたセッションは末尾に付く", async () => {
  await givenPanes(["A", "B"]);
  await reorderTo(["B", "A"]);
  await expect(paneTitles()).toHaveText(["B", "A"]);

  await createSession(page, { cwd: "C:\\app\\C", title: "C" });
  await waitForPaneCount(page, 3);

  await expect(paneTitles()).toHaveText(["B", "A", "C"]);
});

test("並べ替えた後に閉じても残りの順は保たれる", async () => {
  await givenPanes(["A", "B", "C"]);
  await reorderTo(["C", "A", "B"]);
  await expect(paneTitles()).toHaveText(["C", "A", "B"]);

  await page.locator("[data-testid=pane-close]").nth(1).click();
  await waitForPaneCount(page, 2);

  await expect(paneTitles()).toHaveText(["C", "B"]);
});

test.describe("ワークスペースとの往復", () => {
  const wsPath = () => path.join(TEMP_DIR, "ordered.json");

  test("並び順が構成に保存される", async () => {
    await givenPanes(["A", "B", "C"]);
    await reorderTo(["C", "A", "B"]);
    await expect(paneTitles()).toHaveText(["C", "A", "B"]);

    await mockSaveDialog(electronApp, wsPath());
    await page.locator("[data-testid=save-workspace]").click();

    await expect.poll(() => fs.existsSync(wsPath())).toBe(true);
    const saved = JSON.parse(fs.readFileSync(wsPath(), "utf8"));
    expect(saved.sessions.map((s) => s.title)).toEqual(["C", "A", "B"]);
  });

  test("復元すると並び順も再現する", async () => {
    await resetSessions(electronApp, page);
    await mockOpenDialog(electronApp, [wsPath()]);
    await page.locator("[data-testid=restore-workspace]").click();
    await waitForPaneCount(page, 3);

    await expect(paneTitles()).toHaveText(["C", "A", "B"]);
  });

  test("並び順を持たない既存ファイルも読める（配列順に従う）", async () => {
    // 位置情報という項目は増やしていない。並びは sessions 配列の順そのもの
    const legacyPath = path.join(TEMP_DIR, "legacy.json");
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        sessions: [
          { title: "X", cwd: "C:\\app\\X", args: [] },
          { title: "Y", cwd: "C:\\app\\Y", args: [] },
        ],
      }),
      "utf8"
    );

    await resetSessions(electronApp, page);
    await mockOpenDialog(electronApp, [legacyPath]);
    await page.locator("[data-testid=restore-workspace]").click();
    await waitForPaneCount(page, 2);

    await expect(paneTitles()).toHaveText(["X", "Y"]);
  });
});

test.describe("列数", () => {
  const gridColumns = () =>
    page.evaluate(
      () => getComputedStyle(document.getElementById("grid")).gridTemplateColumns
    );

  test("既定は自動", async () => {
    await givenPanes(["A"]);
    await expect(columnsSelect()).toHaveValue("0");
  });

  test("列数を指定するとグリッドが従う", async () => {
    await givenPanes(["A", "B", "C", "D"]);

    await columnsSelect().selectOption("2");
    await expect.poll(async () => (await gridColumns()).split(" ").length).toBe(2);

    await columnsSelect().selectOption("1");
    await expect.poll(async () => (await gridColumns()).split(" ").length).toBe(1);
  });

  test("自動に戻せる", async () => {
    await givenPanes(["A", "B"]);
    await columnsSelect().selectOption("1");
    await expect.poll(async () => (await gridColumns()).split(" ").length).toBe(1);

    await columnsSelect().selectOption("0");
    await expect.poll(async () => (await gridColumns()).split(" ").length).toBe(2);
  });

  test("設定として保存される", async () => {
    await columnsSelect().selectOption("3");

    await expect
      .poll(() => JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")).columns)
      .toBe(3);
  });
});
