import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";

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
  const input = page.locator("[data-testid=font-size]");
  await input.fill("17");
  await input.dispatchEvent("change");

  await expect
    .poll(() => JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")).fontSize)
    .toBe(17);
});
