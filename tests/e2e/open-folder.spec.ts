import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { launchApp, closeApp } from "./helpers/electron-app";
import type { Session } from "../../types/panedeck";

/**
 * フォルダを開いて起動する（2026-10-11）。VS Code の `code <フォルダ>` と同じ考えで、
 * 新しいペインも裏のコマンド（#29）も、開いたフォルダで動く。
 *
 * 裏のコマンドは実プロセスを起こす（相対パスがどこで解決されるかを見るため）。
 */
test.describe.configure({ timeout: 60_000 });

const TEMP_DIR = path.join(__dirname, "temp-open-folder");
const SETTINGS_PATH = path.join(TEMP_DIR, "settings.json");
/** 開くフォルダ。設定とは別の場所にする（同じだと、どちらで解決されたか分からない） */
const FOLDER = path.join(TEMP_DIR, "work");
/** 裏のコマンドが**相対パスで**書くファイル。開いたフォルダに出来れば、そこで動いた */
const MARK = "service-ran.txt";

let electronApp: ElectronApplication;
let page: Page;

async function launchWith(args: string[], services: unknown[] = []) {
  fs.mkdirSync(FOLDER, { recursive: true });
  fs.writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({ autoLog: false, autoRestore: false, services }),
    "utf8"
  );
  ({ electronApp, page } = await launchApp({ settingsPath: SETTINGS_PATH, args }));
}

/** 相対パスでファイルを書いて終わるコマンド（スクリプトは絶対パスに置く） */
function writeMarkCommand(): string {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const script = path.join(TEMP_DIR, "write-mark.js");
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(MARK)}, 'x');`, "utf8");
  return `node ${JSON.stringify(script)}`;
}

test.afterEach(async () => {
  if (electronApp) await closeApp(electronApp);
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

test.describe("フォルダを開いて起動する", () => {
  test("ウィンドウの題に、開いたフォルダが出る", async () => {
    await launchWith([FOLDER]);
    await expect(page).toHaveTitle(`${FOLDER} — PaneDeck`);
  });

  /** 場所を選ぶダイアログを出さない。出ればここで止まり、ペインは増えない */
  test("「+ セッション追加」は、場所を聞かずに開いたフォルダでペインを作る", async () => {
    await launchWith([FOLDER]);
    await page.getByTestId("add-session").click();

    await expect(page.getByTestId("pane-cwd")).toHaveText(FOLDER);
    const cwds = await electronApp.evaluate(() =>
      global.__sessionManager.list().map((s: Session) => s.cwd)
    );
    expect(cwds).toEqual([FOLDER]);
  });

  test("別の場所を選ぶボタンが出る", async () => {
    await launchWith([FOLDER]);
    await expect(page.getByTestId("add-session-elsewhere")).toBeVisible();
  });

  test("裏のコマンドは、開いたフォルダで動く（相対パスがそこで解決される）", async () => {
    await launchWith([FOLDER], [{ name: "mark", command: writeMarkCommand(), restart: "never" }]);
    await expect.poll(() => fs.existsSync(path.join(FOLDER, MARK))).toBe(true);
  });
});

test.describe("フォルダを開かずに起動する（今までどおり）", () => {
  test("題は PaneDeck のまま、別の場所を選ぶボタンは出ない", async () => {
    await launchWith([]);
    await expect(page).toHaveTitle("PaneDeck");
    await expect(page.getByTestId("add-session-elsewhere")).toBeHidden();
  });
});

/** 黙って今までどおりに起動すると、別の場所でサービスが動いたことに気づけない */
test.describe("無いフォルダを渡されたとき", () => {
  test("開けなかったことを知らせる", async () => {
    const nowhere = path.join(TEMP_DIR, "nowhere");
    await launchWith([nowhere]);
    await expect(page.getByTestId("message")).toContainText(nowhere);
    await expect(page.getByTestId("message")).toContainText("開けません");
    await expect(page).toHaveTitle("PaneDeck");
  });
});
