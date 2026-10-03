import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { launchApp, closeApp } from "./helpers/electron-app";

/**
 * 裏で走らせ続けるコマンド（#29）。
 *
 * ここは**実プロセスを起こす**。再起動も後始末も、フェイクでは確かめられない
 * 部分（シェル越しの孫が残るか、など）に用があるため。
 *
 * OS に依存しないよう、コマンドは短命な node スクリプトにする。
 */

/**
 * **ここは既定の 30 秒では足りない。**
 *
 * 他の E2E はフェイクの pty と時計で動くが、このファイルは実プロセスを
 * 起こし、終わるのを待ち、起こし直るのを待つ。CI の遅いマシンでは本体の
 * 待ちで予算を使い切り、`afterEach` のアプリ終了に残らなかった（実際に
 * そうなった —— 落ちたのは本体ではなく時間切れ）。
 */
test.describe.configure({ timeout: 120_000 });

const TEMP_DIR = path.join(__dirname, "temp-service");
const SETTINGS_PATH = path.join(TEMP_DIR, "settings.json");
/** サービスが「生きた証」を書き足すファイル。起動回数をここで数える */
const BEACON = path.join(TEMP_DIR, "beacon.txt");

let electronApp: ElectronApplication;
let page: Page;

/**
 * 一時ディレクトリを作る。**消すのは afterEach だけ**にしてある ——
 * ここで消すと、引数の評価順のせいで先に書いたスクリプトが消える。
 */
function ensureTempDir() {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

async function launchWith(services: unknown[]) {
  ensureTempDir();
  fs.writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({ autoLog: false, autoRestore: false, services }),
    "utf8"
  );

  ({ electronApp, page } = await launchApp({ settingsPath: SETTINGS_PATH }));
}

test.afterEach(async () => {
  if (electronApp) await closeApp(electronApp);
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

/**
 * ファイルに 1 文字書き足して、与えたコードで終わるコマンド。
 *
 * **スクリプトはファイルに書き、改行文字は使わない。** `node -e "..."` へ
 * 直に渡す形だと、引用符とエスケープがシェルを一枚挟むたびに崩れる。
 * 書き足すのを 1 文字にしているのも同じ理由で、数えるのは文字数で足りる。
 */
function beaconCommand(exitCode: number): string {
  ensureTempDir();
  const scriptPath = path.join(TEMP_DIR, `beacon-${exitCode}.js`);
  const lines = [
    `require('fs').appendFileSync(${JSON.stringify(BEACON)}, 'x');`,
    `process.exit(${exitCode});`,
  ];
  fs.writeFileSync(scriptPath, lines.join("\n"), "utf8");
  return `node ${JSON.stringify(scriptPath)}`;
}

/** 走った回数 = 書き足された文字数 */
function beaconRuns(): number {
  if (!fs.existsSync(BEACON)) return 0;
  return fs.readFileSync(BEACON, "utf8").length;
}

/** 終わらないコマンド。走っている状態を見たいとき用 */
function longRunningCommand(name: string, says: string): string {
  ensureTempDir();
  const scriptPath = path.join(TEMP_DIR, `${name}.js`);
  const lines = [
    `console.log(${JSON.stringify(says)});`,
    `setInterval(function () {}, 1000);`,
  ];
  fs.writeFileSync(scriptPath, lines.join("\n"), "utf8");
  return `node ${JSON.stringify(scriptPath)}`;
}

test("設定したコマンドが起動する", async () => {
  await launchWith([{ name: "beacon", command: beaconCommand(0) }]);

  await expect.poll(beaconRuns, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
});

test("落ちたら起こし直す", async () => {
  await launchWith([{ name: "beacon", command: beaconCommand(1) }]);

  // 2 回走ったなら、終了を見て起こし直したということ
  await expect.poll(beaconRuns, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
});

test("restart が never なら起こし直さない", async () => {
  await launchWith([
    { name: "beacon", command: beaconCommand(0), restart: "never" },
  ]);

  await expect.poll(beaconRuns, { timeout: 15_000 }).toBe(1);

  // 最初の待ち時間（1 秒）を十分に越えても増えないこと
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  expect(beaconRuns()).toBe(1);
});

test("様子と出力が画面に出る", async () => {
  await launchWith([
    { name: "feed", command: longRunningCommand("feed", "はじめました") },
  ]);

  const status = page.getByTestId("service-status");
  await expect(status).toBeVisible();
  await expect(status).toHaveText("サービス 1");

  await status.click();
  await expect(page.getByTestId("service-dialog")).toBeVisible();
  await expect(page.getByTestId("service-list")).toContainText("feed — 実行中");

  // stdout がログに出る（ペインには流れない）
  await expect(page.getByTestId("service-log")).toContainText("はじめました", {
    timeout: 15_000,
  });

  // ペインは 1 枚も増えていないこと
  expect(await page.locator(".pane").count()).toBe(0);

  await page.getByTestId("service-close").click();
  await expect(page.getByTestId("service-dialog")).toBeHidden();
});

test("落ち続けていることを隠さない", async () => {
  await launchWith([{ name: "beacon", command: beaconCommand(1) }]);

  const status = page.getByTestId("service-status");
  await expect(status).toHaveClass(/failing/, { timeout: 20_000 });
  await expect(status).toContainText("再起動");
});

test("サービスが無ければ何も出さない", async () => {
  await launchWith([]);
  await expect(page.getByTestId("service-status")).toBeHidden();
});

/**
 * **閉じたら子を残さない。** Windows では、親より長く生きるのが既定の
 * 振る舞いなので、ここを確かめないと気づけない。
 *
 * コマンドはシェルを一枚挟んで起きる（`shell: true`）。`kill()` が起動した
 * プロセスだけを終わらせる実装だと、その先の node が生き残る。
 */
test("閉じたら子プロセスを残さない", async () => {
  ensureTempDir();
  const pidFile = path.join(TEMP_DIR, "pid.txt");
  const scriptPath = path.join(TEMP_DIR, "survivor.js");
  const lines = [
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    `setInterval(function () {}, 1000);`,
  ];
  fs.writeFileSync(scriptPath, lines.join("\n"), "utf8");

  await launchWith([
    { name: "survivor", command: `node ${JSON.stringify(scriptPath)}` },
  ]);

  await expect.poll(() => fs.existsSync(pidFile), { timeout: 15_000 }).toBe(true);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  expect(Number.isFinite(pid)).toBe(true);

  await closeApp(electronApp);
  electronApp = undefined as unknown as ElectronApplication;

  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  await expect.poll(alive, { timeout: 20_000 }).toBe(false);
});
