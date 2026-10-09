import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import {
  launchApp,
  closeApp,
  createSession,
  listSessions,
  resetSessions,
  openSettings,
  closeSettings,
  waitForPaneCount,
} from "./helpers/electron-app";

const TEMP_DIR = path.join(__dirname, "temp-auto-restore");
const SETTINGS_PATH = path.join(TEMP_DIR, "settings.json");
const AUTO_PATH = path.join(TEMP_DIR, "last-session.json");

/**
 * 自動復元は「起動時に実際のプロセスを立ち上げる」ところまでが対象なので、
 * フェイク pty には差し替えられない（差し替えは起動後にしか行えない）。
 * OS 非依存にするため、短命ではなく生き続ける node プロセスを使う。
 */
const NODE = process.execPath;
const STAY_ALIVE = ["-e", "setInterval(() => {}, 1000)"];

let electronApp: ElectronApplication;
let page: Page;

/**
 * アプリを起動し直す。
 *
 * 閉じる前にセッションを畳む。このスイートは生き続ける node プロセスを
 * 立てるので、抱えたままアプリを終わらせると conpty の後始末がアプリの終了と
 * 競合し、**次に起動したアプリが応答を返さなくなる**ことがあった。
 */
/**
 * ★ **どこまで進んだかの足跡（#38）。** 全体試験の中でだけ、relaunch を通る
 * 試験が 30 秒で時間切れになる。狙っても再現せず、単独で回し直すと証拠が
 * 上書きされて消える。だから**失敗したときだけ**、各段に入った時刻を書き出す
 * （`test.step` の名前は HTML の報告にしか出ず、画面にも error-context にも
 * 出なかったので、それだけでは足りない）
 */
const trail: string[] = [];
const t0 = Date.now();
function mark(stage: string) {
  trail.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${stage}`);
}

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) {
    console.error(`[#38 足跡] ${info.title}\n  ` + trail.slice(-8).join("\n  "));
  }
});

async function relaunch() {
  if (electronApp) {
    const app = electronApp;
    mark("relaunch: 閉じる前にセッションを畳む");
    await test.step("relaunch: 閉じる前にセッションを畳む", () =>
      // kill は 1 本ずつ流れる（#38）。済むまで待ってから閉じる
      app.evaluate(async () => {
        global.__sessionManager.closeAll();
        await global.__sessionManager.drained();
      })
    );
    mark("relaunch: 前のアプリを閉じる");
    await test.step("relaunch: 前のアプリを閉じる", () => closeApp(app));
  }
  mark("relaunch: 起動し直す");
  ({ electronApp, page } = await test.step("relaunch: 起動し直す", () =>
    launchApp({ settingsPath: SETTINGS_PATH })
  ));
  mark("relaunch: 起動できた");
}

async function givenSession(title: string) {
  await createSession(page, {
    cwd: TEMP_DIR,
    shell: NODE,
    args: STAY_ALIVE,
    title,
  });
}

function readAutoSaved() {
  return JSON.parse(fs.readFileSync(AUTO_PATH, "utf8"));
}

test.beforeAll(async () => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  await relaunch();
});

test.afterAll(async () => {
  await electronApp.evaluate(() => global.__sessionManager.closeAll());
  await closeApp(electronApp);
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

test("セッションを作ると自動保存ファイルに書き出される", async () => {
  await resetSessions(electronApp, page);
  await givenSession("alpha");
  await waitForPaneCount(page, 1);

  await expect.poll(() => readAutoSaved().sessions.length).toBe(1);
  expect(readAutoSaved().sessions[0].title).toBe("alpha");
  expect(readAutoSaved().sessions[0].cwd).toBe(TEMP_DIR);
});

test("セッションを閉じると自動保存からも消える", async () => {
  await resetSessions(electronApp, page);
  await givenSession("alpha");
  await givenSession("beta");
  await waitForPaneCount(page, 2);
  await expect.poll(() => readAutoSaved().sessions.length).toBe(2);

  await page.locator("[data-testid=pane-close]").first().click();
  await waitForPaneCount(page, 1);

  await expect.poll(() => readAutoSaved().sessions.length).toBe(1);
  expect(readAutoSaved().sessions[0].title).toBe("beta");
});

test("再起動すると前回のセッションが並ぶ", async () => {
  await resetSessions(electronApp, page);
  await givenSession("alpha");
  await givenSession("beta");
  await waitForPaneCount(page, 2);
  await expect.poll(() => readAutoSaved().sessions.length).toBe(2);

  await relaunch();

  await waitForPaneCount(page, 2);
  await expect(page.locator("[data-testid=pane-title]")).toHaveText([
    "alpha",
    "beta",
  ]);
  expect((await listSessions(electronApp)).map((s) => s.cwd)).toEqual([
    TEMP_DIR,
    TEMP_DIR,
  ]);
});

test("起動コマンドとエージェントも復元される", async () => {
  await resetSessions(electronApp, page);
  await createSession(page, {
    cwd: TEMP_DIR,
    shell: NODE,
    args: STAY_ALIVE,
    title: "mixed",
    initialCommand: "codex --resume",
    agent: "codex",
  });
  await waitForPaneCount(page, 1);
  await expect.poll(() => readAutoSaved().sessions.length).toBe(1);

  await relaunch();
  await waitForPaneCount(page, 1);

  const sessions = await listSessions(electronApp);
  expect(sessions[0].initialCommand).toBe("codex --resume");
  expect(sessions[0].agent).toBe("codex");
  await expect(page.locator("[data-testid=pane-command]")).toHaveText(
    "codex --resume"
  );
});

test("全部閉じた状態で再起動すると空のまま", async () => {
  await resetSessions(electronApp, page);
  await givenSession("alpha");
  await waitForPaneCount(page, 1);

  await page.locator("[data-testid=close-all]").click();
  await page.locator("[data-testid=close-all-ok]").click();
  await waitForPaneCount(page, 0);
  await expect.poll(() => readAutoSaved().sessions.length).toBe(0);

  await relaunch();

  await waitForPaneCount(page, 0);
  await expect(page.locator("[data-testid=empty-state]")).toBeVisible();
});

test.describe("自動復元の ON / OFF", () => {
  const toggle = () => page.locator("[data-testid=auto-restore]");

  /** 自動復元は設定ダイアログの中にあるので、開いてから触る */
  async function setAutoRestore(on: boolean) {
    await openSettings(page);
    if (on) await toggle().check();
    else await toggle().uncheck();
    await closeSettings(page);
  }

  async function isAutoRestoreOn(): Promise<boolean> {
    await openSettings(page);
    const checked = await toggle().isChecked();
    await closeSettings(page);
    return checked;
  }

  test("既定は有効", async () => {
    expect(await isAutoRestoreOn()).toBe(true);
  });

  test("無効にすると再起動しても復元されない", async () => {
    await resetSessions(electronApp, page);
    await setAutoRestore(false);
    await givenSession("alpha");
    await waitForPaneCount(page, 1);
    await expect.poll(() => readAutoSaved().sessions.length).toBe(1);

    await relaunch();

    await waitForPaneCount(page, 0);
    expect(await isAutoRestoreOn()).toBe(false);
    await expect(page.locator("[data-testid=empty-state]")).toBeVisible();
  });

  test("無効でも構成の記録自体は続く（戻せば復元できる）", async () => {
    // 記録まで止めると、戻したときに何も残っていない
    expect(await isAutoRestoreOn()).toBe(false);
    expect(readAutoSaved().sessions[0].title).toBe("alpha");

    await setAutoRestore(true);
    await relaunch();

    await waitForPaneCount(page, 1);
    await expect(page.locator("[data-testid=pane-title]")).toHaveText("alpha");
  });
});

test.describe("壊れた自動保存ファイル", () => {
  test("JSON が壊れていても空状態で起動する", async () => {
    await resetSessions(electronApp, page);
    await closeApp(electronApp);
    fs.writeFileSync(AUTO_PATH, "{ これは JSON ではない", "utf8");

    ({ electronApp, page } = await launchApp({ settingsPath: SETTINGS_PATH }));

    await waitForPaneCount(page, 0);
    await expect(page.locator("[data-testid=empty-state]")).toBeVisible();
    expect(await listSessions(electronApp)).toHaveLength(0);
  });

  test("ファイルが無くても空状態で起動する", async () => {
    await closeApp(electronApp);
    fs.rmSync(AUTO_PATH, { force: true });

    ({ electronApp, page } = await launchApp({ settingsPath: SETTINGS_PATH }));

    await waitForPaneCount(page, 0);
    await expect(page.locator("[data-testid=empty-state]")).toBeVisible();
  });
});
