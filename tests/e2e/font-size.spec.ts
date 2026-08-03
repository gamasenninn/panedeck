import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import {
  launchApp,
  closeApp,
  useFakePty,
  createSession,
  listSessions,
  resetSessions,
  waitForPaneCount,
} from "./helpers/electron-app";

const TEMP_DIR = path.join(__dirname, "temp-settings");
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

const fontSizeInput = () => page.locator("[data-testid=font-size]");

/** 画面上の全ペインが実際に使っている文字サイズ */
function paneFontSizes() {
  return page.evaluate(() =>
    // @ts-ignore renderer.js 最上位の const。古典スクリプトなので名前で参照できる
    [...panes.values()].map((pane) => pane.term.options.fontSize)
  );
}

async function setFontSize(value) {
  await fontSizeInput().fill(String(value));
  await fontSizeInput().dispatchEvent("change");
}

async function givenPanes(n) {
  await resetSessions(electronApp, page);
  for (let i = 0; i < n; i++) {
    await createSession(page, { cwd: `C:\\app\\repo-${i}` });
  }
  await waitForPaneCount(page, n);
}

test("既定は 12", async () => {
  await givenPanes(1);

  await expect(fontSizeInput()).toHaveValue("12");
  expect(await paneFontSizes()).toEqual([12]);
});

test("変更すると全ペインに反映される", async () => {
  await givenPanes(3);
  await setFontSize(18);

  await expect.poll(paneFontSizes).toEqual([18, 18, 18]);
});

test("変更後に作ったペインにも現在値が適用される", async () => {
  await givenPanes(1);
  await setFontSize(20);
  await expect.poll(paneFontSizes).toEqual([20]);

  await createSession(page, { cwd: "C:\\app\\repo-new" });
  await waitForPaneCount(page, 2);

  await expect.poll(paneFontSizes).toEqual([20, 20]);
});

test("変更で再フィットが走り、pty 側の桁数・行数も変わる", async () => {
  await givenPanes(1);
  await setFontSize(10);
  await expect.poll(paneFontSizes).toEqual([10]);
  const small = (await listSessions(electronApp))[0];

  await setFontSize(24);
  await expect.poll(paneFontSizes).toEqual([24]);
  const large = (await listSessions(electronApp))[0];

  // 文字が大きくなれば同じ幅に入る桁数は減る
  expect(large.cols).toBeLessThan(small.cols);
  expect(large.rows).toBeLessThan(small.rows);
});

test.describe("範囲外の入力", () => {
  test("大きすぎる値は上限に丸められる", async () => {
    await givenPanes(1);
    await setFontSize(999);

    await expect(fontSizeInput()).toHaveValue("32");
    await expect.poll(paneFontSizes).toEqual([32]);
  });

  test("小さすぎる値は下限に丸められる", async () => {
    await givenPanes(1);
    await setFontSize(1);

    await expect(fontSizeInput()).toHaveValue("8");
    await expect.poll(paneFontSizes).toEqual([8]);
  });

  test("空入力では変更しない", async () => {
    await givenPanes(1);
    await setFontSize(16);
    await expect.poll(paneFontSizes).toEqual([16]);

    await setFontSize("");

    await expect(fontSizeInput()).toHaveValue("16");
    expect(await paneFontSizes()).toEqual([16]);
  });

  test("数値でない値が入り込んでも変更しない", async () => {
    await givenPanes(1);
    await setFontSize(16);
    await expect.poll(paneFontSizes).toEqual([16]);

    // input[type=number] は非数値の入力を弾くので、ユーザーの手では到達できない。
    // 値を直接差し込んで、それでもガードが効くことだけを見る
    await page.evaluate(() => {
      const input = document.getElementById("font-size") as HTMLInputElement;
      input.value = "abc";
      input.dispatchEvent(new Event("change"));
    });

    await expect(fontSizeInput()).toHaveValue("16");
    expect(await paneFontSizes()).toEqual([16]);
  });
});

test.describe("永続化", () => {
  test("設定ファイルに書き出される", async () => {
    await givenPanes(1);
    await setFontSize(22);

    await expect
      .poll(() => JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")).fontSize)
      .toBe(22);
  });

  test("アプリを再起動しても維持される", async () => {
    await givenPanes(1);
    await setFontSize(26);
    await expect
      .poll(() => JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")).fontSize)
      .toBe(26);

    await closeApp(electronApp);
    ({ electronApp, page } = await launchApp({ settingsPath: SETTINGS_PATH }));
    await useFakePty(electronApp);

    await expect(fontSizeInput()).toHaveValue("26");

    await createSession(page, { cwd: "C:\\app\\repo-after-restart" });
    await waitForPaneCount(page, 1);
    await expect.poll(paneFontSizes).toEqual([26]);
  });
});
