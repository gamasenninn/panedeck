import { test, expect } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  launchApp,
  closeApp,
  useFakePty,
  createSession,
  emitPtyData,
  emitPtyExit,
  waitForPaneCount,
} from "../e2e/helpers/electron-app";

/**
 * README 用のデモを収録する。テストではないので既定の実行には含めない。
 *
 *     npm run demo
 *
 * pty はフェイクに差し替えている。実物のエージェントを撮ると、手元のパスや
 * 進行中の作業が写り込むうえ、撮り直すたびに中身が変わる。流し込む出力は
 * **判定パターンに実際に一致するもの**にしてあるので、映っているバッジは
 * 演出ではなく本物の判定結果。
 *
 * 尺を作るのが目的なので、ここでは待ち時間を明示的に置く（テストの
 * page.waitForTimeout を避ける規約は、待ちが偶然に頼るときの話）。
 */

const VIDEO_DIR = path.resolve(__dirname, "..", "..", ".demo");

/**
 * 録画枠の大きさ。レンダラの実寸（CSS ピクセル）に合わせる。
 * ウィンドウは 1400x900 だが、枠のぶんと devicePixelRatio でこの値になる。
 */
const VIDEO_SIZE = { width: 1153, height: 696 };

/** 状態が切り替わるのを見せる。判定は出力が 400ms 止まってから動く */
const SETTLE = 900;
/** 読む時間 */
const BEAT = 1400;

const SESSIONS = [
  { title: "api-server", cwd: "C:\\work\\api-server", agent: "claude", command: "claude" },
  { title: "web-client", cwd: "C:\\work\\web-client", agent: "codex", command: "codex" },
  { title: "docs-site", cwd: "C:\\work\\docs-site", agent: "claude", command: "claude" },
  { title: "infra", cwd: "C:\\work\\infra", agent: "shell", command: "" },
];

test("demo", async () => {
  fs.rmSync(VIDEO_DIR, { recursive: true, force: true });

  // 2 列で並べたいので、設定を先に置いてから起動する
  const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "panedeck-demo-"));
  const settingsPath = path.join(settingsDir, "settings.json");
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ columns: 2, fontSize: 13, autoLog: false, autoRestore: false })
  );

  // 実寸で録る。既定のままだと枠が画面より縦長になり、下に灰色の帯が残る
  const { electronApp, page } = await launchApp({
    settingsPath,
    recordVideo: { dir: VIDEO_DIR, size: VIDEO_SIZE },
  });
  await useFakePty(electronApp);

  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  if (viewport.width !== VIDEO_SIZE.width || viewport.height !== VIDEO_SIZE.height) {
    console.warn(
      `画面の実寸が ${viewport.width}x${viewport.height} です。` +
        `VIDEO_SIZE を合わせないと余白が入ります`
    );
  }

  const wait = (ms: number) => page.waitForTimeout(ms);
  const emit = (index: number, text: string) => emitPtyData(electronApp, index, text);

  await wait(BEAT);

  // --- セッションを並べる ---------------------------------------------------
  for (const [index, session] of SESSIONS.entries()) {
    await createSession(page, {
      cwd: session.cwd,
      title: session.title,
      agent: session.agent,
      initialCommand: session.command,
    });
    await waitForPaneCount(page, index + 1);
    await wait(450);
  }

  await wait(BEAT);

  // --- それぞれ動き出す（実行中） -------------------------------------------
  await emit(0, "\r\n\x1b[36m$ claude\x1b[0m\r\n> add rate limiting to the upload endpoint\r\n");
  await emit(1, "\r\n\x1b[36m$ codex\x1b[0m\r\n  refactor the settings panel\r\n");
  await emit(2, "\r\n\x1b[36m$ claude\x1b[0m\r\n> rewrite the getting-started page\r\n");
  await emit(3, "\r\n\x1b[36m$ npm run deploy:check\x1b[0m\r\n");
  await wait(600);

  await emit(0, "  reading src/routes/upload.ts\r\n");
  await emit(1, "  reading src/panels/Settings.tsx\r\n");
  await emit(2, "  reading docs/getting-started.md\r\n");
  await emit(3, "  checking terraform plan\r\n");
  await wait(600);

  await emit(1, "  extracting SettingsField\r\n");
  await emit(2, "  found 3 sections to rewrite\r\n");
  await wait(BEAT);

  // --- 2 つが入力待ちで止まる -----------------------------------------------
  // [y/n] と ❯ はどちらも実際の待機パターン（lib/status-detector.ts）
  await emit(
    0,
    "\r\n  add a token-bucket limiter (60 req/min)\r\n\r\n\x1b[33mApply this change? [y/n]\x1b[0m "
  );
  await emit(2, "\r\n  which tone should the intro use?\r\n\r\n  \x1b[33m❯ concise\x1b[0m\r\n    detailed\r\n");
  // 3 つ目は動き続け、4 つ目は終わる
  await emit(1, "  updating imports\r\n");
  await emit(3, "  plan is clean, nothing to apply\r\n");
  await emitPtyExit(electronApp, 3, 0);

  await wait(SETTLE);
  await wait(BEAT);

  // --- 入力待ちのペインだけに送る -------------------------------------------
  await page.locator("[data-testid=waiting-only]").check();
  await wait(BEAT);

  // 止まっているペインを Enter で進める。これがこの機能の主用途
  await page.locator("[data-testid=key-enter]").click();
  await wait(400);

  // 両方が動き出す。判定は末尾 10 行を見るので、プロンプトが窓から出るまで
  // 流さないとバッジは入力待ちのまま。実際の進み方に合わせて出力を続ける
  await emit(0, "y\r\n  applied\r\n  running tests\r\n");
  await emit(2, "\r\n  rewriting the intro\r\n");
  await wait(500);

  await emit(0, "    src/routes/upload.test.ts\r\n    rejects the 61st request\r\n");
  await emit(2, "    docs/getting-started.md\r\n    trimmed 42 lines\r\n");
  await wait(500);

  await emit(0, "    resets the bucket after a minute\r\n    leaves other routes alone\r\n");
  await emit(2, "    updated the install steps\r\n    updated the first example\r\n");
  await wait(500);

  await emit(0, "  12 passed in 1.4s\r\n    updated CHANGELOG.md\r\n");
  await emit(2, "  3 sections rewritten\r\n    checked every link\r\n");
  await wait(500);

  // ここまでで、プロンプトの行が末尾 10 行の窓から出る。
  // 出し切らないとバッジは入力待ちのまま留まる（判定は末尾しか見ない）
  await emit(0, "    staged 3 files\r\n  ready to commit\r\n");
  await emit(2, "    updated the table of contents\r\n  ready for review\r\n");
  await wait(SETTLE);
  await wait(BEAT);

  // --- 1 ペインだけ拡大して戻す ---------------------------------------------
  // 撮れていなければ気づけるように、状態そのものを確かめてから進める
  await page.locator("[data-testid=pane-maximize]").first().click();
  await expect(page.locator(".pane:visible")).toHaveCount(1);
  await wait(700);

  await emit(0, "\r\n\x1b[32mrate limiting added to POST /upload\x1b[0m\r\n");
  await wait(BEAT + 400);

  await page.locator("[data-testid=pane-maximize]").first().click();
  await expect(page.locator(".pane:visible")).toHaveCount(SESSIONS.length);
  await wait(BEAT);

  await closeApp(electronApp);
  fs.rmSync(settingsDir, { recursive: true, force: true });
});
