import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  useFakePty,
  useFakeClock,
  advanceClock,
  emitPtyData,
} from "../e2e/helpers/electron-app";

/**
 * パッケージ版の生成物を実際に起動して確かめる。
 *
 * 開発時と違い、ここでは asar の中から index.html と dist/ が読めるか、
 * node-pty が展開先から読み込めるか（ABI 不一致で落ちないか）が焦点になる。
 * 「開発では動くがパッケージ版だけ落ちる」を捕まえるのがこのテストの役目。
 *
 * `npm run pack` の生成物が要るので、既定のテスト実行には含めない。
 * `npm run test:packaged` で走らせる。
 */

const EXE = path.resolve(
  __dirname,
  "..",
  "..",
  "release",
  "win-unpacked",
  "PaneDeck.exe"
);

const TEMP_DIR = path.join(os.tmpdir(), "panedeck-packaged-test");
const SETTINGS_PATH = path.join(TEMP_DIR, "settings.json");

const MARKER = "PANEDECK_PACKAGED_OK";

/** 短命なコマンド。開発側の real-pty テストと同じ形にそろえる */
const REAL_SHELL =
  process.platform === "win32"
    ? {
        shell: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-Command", `Write-Output ${MARKER}`],
      }
    : { shell: "bash", args: ["-c", `echo ${MARKER}`] };

let electronApp: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  if (!fs.existsSync(EXE)) {
    throw new Error(
      `パッケージ版が見つかりません: ${EXE}\n先に npm run pack を実行してください。`
    );
  }

  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  electronApp = await electron.launch({
    executablePath: EXE,
    args: [],
    env: {
      ...process.env,
      PANEDECK_SETTINGS_PATH: SETTINGS_PATH,
    } as Record<string, string>,
  });
  page = await electronApp.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  if (electronApp) await electronApp.close();
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

test("ウィンドウが開き、UI が描画される", async () => {
  // index.html と dist/renderer.js が asar から読めている
  await expect(page.locator("[data-testid=add-session]")).toBeVisible();
  await expect(page.locator("[data-testid=empty-state]")).toBeVisible();
  await expect(page.locator("[data-testid=session-count]")).toHaveText("0 セッション");
});

test("レンダラのモジュール読み込みが成功している", async () => {
  // ESM の相対 import が解決できていないと、ツールバーの中身が組み立たない。
  // エージェント選択は listAgents の結果で作られるので、IPC も通っている証拠になる
  const agents = await page
    .locator("[data-testid=agent-select] option")
    .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value));

  expect(agents).toContain("claude");
  expect(agents).toContain("codex");
});

test("node-pty が読み込め、実プロセスを起動できる", async () => {
  // ここが本題。ABI 不一致やアンパック漏れがあるとこのテストが落ちる。
  //
  // 生成と読み出しを別々の evaluate に分ける。1 つの evaluate の中で生成して
  // そのまま出力を待つと、待っている間メインプロセスの応答が返らず固まる。
  const created = await electronApp.evaluate(
    (_, { cwd, shell, args }) => {
      try {
        const session = global.__sessionManager.create({
          cwd,
          shell,
          args,
          title: "packaged",
        });
        return { ok: true as const, id: session.id };
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    },
    { cwd: TEMP_DIR, ...REAL_SHELL }
  );

  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.error);

  await page.waitForFunction(() => document.querySelectorAll(".pane").length === 1);

  // pty の出力がメインプロセスのログに溜まる
  await expect
    .poll(
      () =>
        electronApp.evaluate(
          (_, id) => global.__sessionManager.getLog(id),
          created.id
        ),
      { timeout: 20000 }
    )
    .toContain(MARKER);

  // プロセスの終了も検知できる
  await expect
    .poll(
      () =>
        electronApp.evaluate(
          (_, id) => global.__sessionManager.get(id)?.status,
          created.id
        ),
      { timeout: 20000 }
    )
    .toBe("exited");
});

test("設定ファイルを読み書きできる", async () => {
  // **ダイアログを開いてから触る。** 設定がツールバーからダイアログへ移った
  // とき（1511ddf）、この試験は開かずに触り続けていて壊れていた。
  // `npm test` にも CI にも入っていないので、誰も気づかなかった
  await page.locator("[data-testid=open-settings]").click();
  const input = page.locator("[data-testid=font-size]");
  await expect(input).toBeVisible();

  await input.fill("17");
  await input.dispatchEvent("change");

  await expect
    .poll(() => JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")).fontSize)
    .toBe(17);
});


/**
 * パッケージ版でも**画面から**状態を判定できること（#31）。
 *
 * ★ **ここはパッケージ版でしか壊れない。** 画面は `@xterm/headless` という
 * npm の依存で、**main プロセスだけ**が使う。asar に入っていなければ、
 * 開発では動くのにパッケージ版だけ画面を持てず、記録の末尾を見る古い方式へ
 * 落ちる —— #31 で直した取りこぼしが黙って戻る。
 *
 * 見分け方は #31 の e2e と同じ: **下にフッターを描き、上を何度も塗り替える。**
 * 記録の末尾からはフッターが流れて消えるが、画面には残っている。
 */
test("パッケージ版でも画面から状態を判定する", async () => {
  await useFakePty(electronApp);
  await useFakeClock(electronApp);

  // 大きさを決めて作る（塗り替えの行を指定するため）
  const created = await electronApp.evaluate(() =>
    global.__sessionManager.create({ cwd: process.cwd(), agent: "claude", cols: 60, rows: 12 })
  );

  // **下の行にフッターを描き、上の行だけを塗り替える。**
  // 改行を使わないので画面は流れない。記録だけが伸びてフッターが末尾から外れる
  await emitPtyData(electronApp, 0, "[12;1H⏸ manual mode on · ? for shortcuts");
  for (let i = 0; i < 60; i++) {
    await emitPtyData(electronApp, 0, `[1;1H作業中 ${i} ..........................`);
  }
  await advanceClock(electronApp, 1000);

  const status = await electronApp.evaluate(
    ({}, id) => global.__sessionManager.get(id)?.status,
    created.id
  );

  // 画面を見ていれば指示待ち。記録の末尾しか見られないなら、そうはならない
  expect(status).toBe("ready");

  await electronApp.evaluate(({}, id) => global.__sessionManager.close(id), created.id);
});
