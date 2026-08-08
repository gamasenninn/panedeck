import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import {
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
  openSettings,
  closeSettings,
  waitForPaneCount,
} from "./helpers/electron-app";

const TEMP_DIR = path.join(__dirname, "temp-layout");
const SETTINGS_PATH = path.join(TEMP_DIR, "settings.json");

let electronApp: ElectronApplication;
let page: Page;

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

/** 列数は設定ダイアログの中にあるので、開いてから触る */
async function setColumns(value: string) {
  await openSettings(page);
  await columnsSelect().selectOption(value);
  await closeSettings(page);
}

async function shownColumns(): Promise<string> {
  await openSettings(page);
  const value = await columnsSelect().inputValue();
  await closeSettings(page);
  return value;
}

/** メインプロセス側の並び順 */
async function orderInMain() {
  return (await listSessions(electronApp)).map((s) => s.title);
}

async function givenPanes(titles: string[]) {
  await resetSessions(electronApp, page);
  for (const title of titles) {
    await createSession(page, { cwd: `C:\\app\\${title}`, title });
  }
  await waitForPaneCount(page, titles.length);
}

/**
 * レンダラ経由で並べ替える（D&D の結果として起きることと同じ）。
 *
 * ペインとセッションの対応は DOM から取る（`data-session-id`）。レンダラの
 * 内部変数には触れない。
 */
async function reorderTo(titles: string[]) {
  await page.evaluate(async (wanted) => {
    const byTitle = new Map(
      [...document.querySelectorAll<HTMLElement>(".pane")].map((el) => [
        el.querySelector("[data-testid=pane-title]")!.textContent!,
        el.dataset.sessionId!,
      ])
    );
    await window.deck.reorderSessions(wanted.map((t) => byTitle.get(t)!));
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
  const box = (await target.boundingBox())!;
  await source.dragTo(target, {
    targetPosition: { x: box.width * 0.2, y: box.height * 0.1 },
  });

  await expect(paneTitles()).toHaveText(["C", "A", "B"]);
  expect(await orderInMain()).toEqual(["C", "A", "B"]);
});

test("端末の上ではドラッグを始めない（文字選択の邪魔をしない）", async () => {
  await givenPanes(["A", "B"]);

  const body = page.locator(".pane").nth(0).locator(".pane-body");
  expect(await body.evaluate((el: HTMLElement) => el.draggable)).toBe(false);

  const header = page.locator(".pane").nth(0).locator(".pane-header");
  expect(await header.evaluate((el: HTMLElement) => el.draggable)).toBe(true);
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
    expect(saved.sessions.map((s: { title: string }) => s.title)).toEqual(["C", "A", "B"]);
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
      () => getComputedStyle(document.getElementById("grid")!).gridTemplateColumns
    );

  test("既定は自動", async () => {
    await givenPanes(["A"]);
    expect(await shownColumns()).toBe("0");
  });

  test("列数を指定するとグリッドが従う", async () => {
    await givenPanes(["A", "B", "C", "D"]);

    await setColumns("2");
    await expect.poll(async () => (await gridColumns()).split(" ").length).toBe(2);

    await setColumns("1");
    await expect.poll(async () => (await gridColumns()).split(" ").length).toBe(1);
  });

  test("自動に戻せる", async () => {
    // 自動のときのトラック数はウィンドウ幅で変わる（auto-fit）ので、数では
    // 見ない。列数を指定したときだけ inline style が付く実装なので、
    // 「指定が外れたこと」で確かめる
    const inlineColumns = () =>
      page.evaluate(() => document.getElementById("grid")!.style.gridTemplateColumns);

    await givenPanes(["A", "B"]);
    await setColumns("1");
    // 値そのものは見ない。ブラウザが正規化する（0 → 0px）
    await expect.poll(inlineColumns).not.toBe("");
    await expect.poll(async () => (await gridColumns()).split(" ").length).toBe(1);

    await setColumns("0");
    await expect.poll(inlineColumns).toBe("");
    // 1 列に固定されたままでないこと。実際の本数は幅次第なので下限だけ見る
    await expect
      .poll(async () => (await gridColumns()).split(" ").length)
      .toBeGreaterThan(1);
  });

  test("設定として保存される", async () => {
    await setColumns("3");

    await expect
      .poll(() => JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")).columns)
      .toBe(3);
  });
});
