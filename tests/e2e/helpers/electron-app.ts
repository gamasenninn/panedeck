import { _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";

export const APP_PATH = path.resolve(__dirname, "..", "..", "..");

/**
 * 起動ごとに用意した一時ディレクトリ。closeApp で消す。
 *
 * 設定パスを渡さないテストが実ユーザーの userData を読み書きしてしまうのを
 * 防ぐため、渡されなかったときはここに逃がす。放っておくと、テストが
 * ユーザーの設定（自動保存の ON/OFF など）に従って動き、ユーザーの
 * フォルダへテスト用のログを書き散らす。
 */
const disposableDirs = new Map<ElectronApplication, string[]>();

/**
 * Electron アプリを起動し、アプリと最初のウィンドウを返す。
 *
 * `settingsPath` を渡すと設定ファイルの場所を差し替える。レンダラは起動直後に
 * 設定を読むので、起動後に注入する方式では初回の読み込みに間に合わない。
 * 環境変数なら main が最初に見るところに割り込めるうえ、アプリを再起動する
 * テストでも同じ場所を指し続けられる。
 */
export async function launchApp({
  settingsPath,
  recordVideo,
  args = [],
}: {
  settingsPath?: string;
  /** アプリへ渡す引数（例: 開くフォルダ）。アプリの場所の後ろに付く */
  args?: string[];
  /**
   * 画面を録る（デモ収録用。テストでは使わない）。
   *
   * `size` を渡さないと Playwright が 800x800 に収まるよう縮めた枠で録り、
   * 画面より枠が縦長になって下に灰色の帯が残る。実寸を渡すこと。
   */
  recordVideo?: { dir: string; size?: { width: number; height: number } };
} = {}): Promise<{
  electronApp: ElectronApplication;
  page: Page;
}> {
  // 渡されなければ捨ててよい場所を用意する。実ユーザーの userData は使わない
  const disposableSettings = settingsPath
    ? null
    : fs.mkdtempSync(path.join(os.tmpdir(), "panedeck-e2e-"));
  const resolved = settingsPath ?? path.join(disposableSettings!, "settings.json");

  const electronApp = await electron.launch({
    args: [APP_PATH, ...args],
    ...(recordVideo ? { recordVideo } : {}),
    env: {
      ...process.env,
      PANEDECK_SETTINGS_PATH: resolved,
      // 既定ではウィンドウを出さずに回す。見ながら追いたいときは
      // npm run test:headed（PANEDECK_SHOW_WINDOW=1）
      PANEDECK_HIDE_WINDOW: process.env.PANEDECK_SHOW_WINDOW === "1" ? "0" : "1",
    } as Record<string, string>,
  });

  if (disposableSettings) disposableDirs.set(electronApp, [disposableSettings]);

  const page = await electronApp.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { electronApp, page };
}

/**
 * アプリを終了する。
 */
export async function closeApp(electronApp: ElectronApplication) {
  await electronApp.close();

  for (const dir of disposableDirs.get(electronApp) ?? []) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  disposableDirs.delete(electronApp);
}

/**
 * SessionManager の ptyFactory をフェイクに差し替える。
 *
 * 実プロセスを起動しないので、E2E でも write / kill / 出力の発火を
 * 決定的に検証できる。生成された pty は `global.__fakePtys` に積まれる。
 */
export async function useFakePty(electronApp: ElectronApplication) {
  await electronApp.evaluate(() => {
    global.__fakePtys = [];
    global.__sessionManager.ptyFactory = (options: unknown) => {
      const dataHandlers: Array<(data: string) => void> = [];
      const exitHandlers: Array<(event: { exitCode: number }) => void> = [];
      const fake = {
        options,
        written: [] as string[],
        killed: false,
        write: (data: string) => fake.written.push(data),
        resize: () => {},
        // 本物と同じく、kill されたら少し後に終了を知らせる。知らせないと
        // kill の順番待ち（#38）が毎回上限の 1 秒まで待ち、閉じるたびに
        // 「ペインの数 × 1 秒」かかっていた（全体試験が 3.9 分 → 5.3 分）
        kill: () => {
          if (fake.killed) return;
          fake.killed = true;
          setTimeout(() => exitHandlers.forEach((cb) => cb({ exitCode: -1073741510 })), 10);
        },
        onData: (cb: (data: string) => void) => dataHandlers.push(cb),
        onExit: (cb: (event: { exitCode: number }) => void) => exitHandlers.push(cb),
        emitData: (data: string) => dataHandlers.forEach((cb) => cb(data)),
        emitExit: (exitCode: number) =>
          exitHandlers.forEach((cb) => cb({ exitCode })),
      };
      global.__fakePtys.push(fake);
      return fake;
    };
  });
}

/**
 * レンダラ経由でセッションを作る（ディレクトリ選択ダイアログを通さない）。
 */
export async function createSession(page: Page, options: Record<string, unknown>) {
  return page.evaluate((opts) => window.deck.createSession(opts), options);
}

/**
 * フェイク pty から出力を発火させる。
 */
export async function emitPtyData(electronApp: ElectronApplication, index: number, data: string) {
  await electronApp.evaluate(
    (_, { index: i, data: d }) => global.__fakePtys.at(i).emitData(d),
    { index, data }
  );
}

/**
 * フェイク pty のプロセス終了を発火させる。
 */
export async function emitPtyExit(electronApp: ElectronApplication, index: number, exitCode = 0) {
  await electronApp.evaluate(
    (_, { index: i, exitCode: c }) => global.__fakePtys.at(i).emitExit(c),
    { index, exitCode }
  );
}

/**
 * フェイク pty に書き込まれた内容を取り出す。
 */
export async function writtenTo(electronApp: ElectronApplication, index: number): Promise<string[]> {
  return electronApp.evaluate((_, i) => global.__fakePtys.at(i).written, index);
}

/**
 * 流し込まれたコマンドを、**会話の id を伏せた形**で取り出す（#33）。
 *
 * 会話の id は起動のたびに違うので、そのままでは比べられない。伏せても
 * 「付いていること」と「UUID の形であること」は確かめられる。
 */
export async function launchedIn(
  electronApp: ElectronApplication,
  index: number
): Promise<string[]> {
  const written = await writtenTo(electronApp, index);
  return written.map((text) =>
    text.replace(
      / --session-id [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
      " --session-id <uuid>"
    )
  );
}

/**
 * 現在のセッション一覧をメインプロセスから直接取得する。
 */
export async function listSessions(electronApp: ElectronApplication): Promise<any[]> {
  return electronApp.evaluate(() => global.__sessionManager.list());
}

/**
 * dialog.showOpenDialog をディレクトリ選択のモックに差し替える。
 */
export async function mockOpenDialog(electronApp: ElectronApplication, filePaths: string[]) {
  await electronApp.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
  }, filePaths);
}

/**
 * dialog.showOpenDialog をキャンセルのモックに差し替える。
 */
export async function mockOpenDialogCancel(electronApp: ElectronApplication) {
  await electronApp.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
}

/**
 * dialog.showSaveDialog を保存先固定のモックに差し替える。
 */
export async function mockSaveDialog(electronApp: ElectronApplication, filePath: string) {
  await electronApp.evaluate(({ dialog }, fp) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: fp });
  }, filePath);
}

/**
 * dialog.showSaveDialog をキャンセルのモックに差し替える。
 */
export async function mockSaveDialogCancel(electronApp: ElectronApplication) {
  await electronApp.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" });
  });
}

/**
 * 全セッションを閉じ、フェイク pty の記録も消してテスト間の状態をリセットする。
 * リセット後は `global.__fakePtys` の添字が 0 から始まる。
 *
 * page を渡すと、画面上のペインが実際に消えるまで待つ。レンダラはセッション一覧を
 * ポーリングして追従するため、これを待たないと「前のテストの残骸ペイン」で
 * waitForPaneCount が即座に成立し、消える直前のペインを操作してしまう。
 */
export async function resetSessions(electronApp: ElectronApplication, page?: Page) {
  await electronApp.evaluate(() => {
    global.__sessionManager.closeAll();
    global.__fakePtys = [];
  });
  if (page) await waitForPaneCount(page, 0);
}

/**
 * SessionManager の時計をテストから操作できる固定クロックに差し替える。
 *
 * 状態判定は「最後の出力からの経過時間」で決まるため、実時間に頼ると
 * running / idle の切り替わりがテストごとにブレる。クロックを固定すれば
 * 状態遷移を決定的に検証できる。
 */
export async function useFakeClock(electronApp: ElectronApplication, start = 1000) {
  await electronApp.evaluate((_, t) => {
    global.__clock = t;
    global.__sessionManager.now = () => global.__clock;
  }, start);
}

/**
 * 固定クロックを進める。
 */
export async function advanceClock(electronApp: ElectronApplication, ms: number) {
  await electronApp.evaluate((_, delta) => {
    global.__clock += delta;
  }, ms);
}

/**
 * 設定ダイアログを開く。
 *
 * 文字サイズ・列数・自動復元・ログの設定はここに入っている。閉じたままでは
 * Playwright が操作できないので、触る前に必ず開くこと。
 */
export async function openSettings(page: Page) {
  await page.locator("[data-testid=open-settings]").click();
  await page.locator("[data-testid=settings-dialog]").waitFor({ state: "visible" });
}

export async function closeSettings(page: Page) {
  await page.locator("[data-testid=close-settings]").click();
  await page.locator("[data-testid=settings-dialog]").waitFor({ state: "hidden" });
}

/**
 * ペインが指定数になるまで待つ。
 */
export async function waitForPaneCount(page: Page, count: number) {
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".pane").length === expected,
    count
  );
}
