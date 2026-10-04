import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { launchApp, closeApp, waitForPaneCount } from "./helpers/electron-app";
import { stripAnsi } from "../../lib/status-detector";

/**
 * 復元したペインを、それぞれ自分の会話へ戻す（#33）。
 *
 * **ここで見るのは「どう起こしたか」**。本物のエージェントは起こさない
 * （記録の有無で分岐するところまでが PaneDeck の仕事で、再開そのものは
 * エージェントの仕事）。起こし方は、ペインに流し込まれた文字で分かる。
 */

const TEMP_DIR = path.join(__dirname, "temp-resume");
const SETTINGS_PATH = path.join(TEMP_DIR, "settings.json");
const RESTORE_PATH = path.join(TEMP_DIR, "last-session.json");
const WORK = path.join(TEMP_DIR, "work");

/** 会話の記録を、claude が置く場所に合わせて作る */
function recordFile(cwd: string, sessionId: string): string {
  const key = cwd.replace(/[:\\/]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", key, `${sessionId}.jsonl`);
}

let electronApp: ElectronApplication;
let page: Page;
/** 片付けるために、作った記録を覚えておく */
const madeRecords: string[] = [];

/**
 * 起動コマンドは `echo`。**本物の claude は起こさない。**
 *
 * 確かめたいのは「PaneDeck がどう起こしたか」で、再開そのものは
 * エージェントの仕事。`agent: "claude"` にすれば呼び方は claude のものが
 * 使われるので、**何を起こすかは関係ない** —— クォータも使わない。
 */
const COMMAND = "echo";

async function launchWith(entries: unknown[]) {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({ autoLog: false, autoRestore: true }),
    "utf8"
  );
  fs.writeFileSync(
    RESTORE_PATH,
    JSON.stringify({ version: 1, name: "last-session", sessions: entries }),
    "utf8"
  );

  ({ electronApp, page } = await launchApp({ settingsPath: SETTINGS_PATH }));
}

/**
 * 復元されたペインの記録。
 *
 * **実 pty なので「書き込んだ文字」は覗けない**（あれはフェイクの持ち物）。
 * 流し込んだコマンドはシェルが echo するので、記録に現れる。
 */
/**
 * 比べるために空白を落とす。
 *
 * **端末は 80 桁で折り返す。** プロンプトが長いと、流し込んだコマンドの
 * 途中に改行が割り込むので、そのままでは部分一致が取れない（実際に踏んだ）。
 *
 * ★★ **「含まれないこと」をこの記録で見てはいけない。** PSReadLine は
 * 履歴からの候補を薄い字で**端末に書く**ので、前のテストで打った
 * `echo --session-id <別の uuid>` が記録に現れる。CI でこれに引っかかり、
 * ペインが会話を取り違えたと誤って判定した。**「含まれること」だけを見る。**
 */
function compact(text: string): string {
  return stripAnsi(text).replace(/\s+/g, "");
}

async function rawLogOf(index: number): Promise<string> {
  return electronApp.evaluate(({}, i) => {
    const sessions = global.__sessionManager.list();
    const id = sessions[i]?.id;
    // `get()` はスナップショットなので記録を含まない。記録は `getLog()`
    return id ? global.__sessionManager.getLog(id) : "";
  }, index);
}

/** 折り返しを無視して読める形の記録 */
async function logOf(index: number): Promise<string> {
  return compact(await rawLogOf(index));
}

/**
 * 題で引いた記録。
 *
 * **添字では順序に依存する。** 2 枚を見分けるときは題で引く
 * （どちらがどちらか取り違えていないことが、この機能の肝なので）。
 */
async function logByTitle(title: string): Promise<string> {
  const raw = await electronApp.evaluate(({}, t) => {
    const found = global.__sessionManager.list().find((s: any) => s.title === t);
    return found ? global.__sessionManager.getLog(found.id) : "";
  }, title);
  return compact(raw);
}

test.afterEach(async () => {
  if (electronApp) await closeApp(electronApp);
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  for (const file of madeRecords.splice(0)) {
    fs.rmSync(file, { force: true });
  }
});

test("記録があるペインは、その会話を再開して起こす", async () => {
  const id = "11111111-2222-3333-4444-555555555555";
  const file = recordFile(WORK, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}\n", "utf8");
  madeRecords.push(file);

  await launchWith([
    { cwd: WORK, args: [], initialCommand: COMMAND, agent: "claude", sessionId: id },
  ]);
  await waitForPaneCount(page, 1);

  await expect
    .poll(() => logOf(0), { timeout: 15_000 })
    .toContain(compact(`echo --resume ${id}`));
});

/** 一度も会話せずに閉じたペインには記録が無い。再開は失敗するので試さない */
test("記録が無いペインは、新しい会話で起こす", async () => {
  const id = "99999999-8888-7777-6666-555555555555";

  await launchWith([
    { cwd: WORK, args: [], initialCommand: COMMAND, agent: "claude", sessionId: id },
  ]);
  await waitForPaneCount(page, 1);

  // 保存されていた id は捨てて、新しい id で始める形になる
  await expect.poll(() => logOf(0), { timeout: 15_000 }).toContain("--session-id");

  const ids = await electronApp.evaluate(() =>
    global.__sessionManager.list().map((s: any) => s.sessionId)
  );
  expect(ids[0]).not.toBe(id);
  expect(ids[0]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  );
});

/** 受付のような常駐。記録があっても再開しない */
test("再開しない印のペインは、記録があっても新しい会話で起こす", async () => {
  const id = "22222222-3333-4444-5555-666666666666";
  const file = recordFile(WORK, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}\n", "utf8");
  madeRecords.push(file);

  await launchWith([
    {
      cwd: WORK,
      args: [],
      initialCommand: COMMAND,
      agent: "claude",
      sessionId: id,
      noResume: true,
    },
  ]);
  await waitForPaneCount(page, 1);

  await expect.poll(() => logOf(0), { timeout: 15_000 }).toContain("--session-id");

  // 記録があっても再開しない。保存されていた id ではない id で立つ
  const ids = await electronApp.evaluate(() =>
    global.__sessionManager.list().map((s: any) => s.sessionId)
  );
  expect(ids[0]).not.toBe(id);
});

/** 会話の概念が無いプロファイルは、今までどおり起こす */
test("shell のペインには会話の指定を付けない", async () => {
  await launchWith([
    { cwd: WORK, args: [], initialCommand: "echo hi", agent: "shell" },
  ]);
  await waitForPaneCount(page, 1);

  await expect.poll(() => logOf(0), { timeout: 15_000 }).toContain(compact("echo hi"));

  // 会話の id を持たない（記録で見ると履歴の候補を拾うので、セッションで見る）
  const ids = await electronApp.evaluate(() =>
    global.__sessionManager.list().map((s: any) => s.sessionId ?? null)
  );
  expect(ids).toEqual([null]);
});

/**
 * **同じディレクトリの 2 枚が、別々の会話へ戻る。**
 *
 * `--continue` では果たせない条件 —— あれは作業ディレクトリの最後の会話を
 * 開くので、2 枚が同じ会話を開く。
 */
test("同じディレクトリの 2 枚が、それぞれ自分の会話へ戻る", async () => {
  const first = "aaaaaaaa-1111-1111-1111-111111111111";
  const second = "bbbbbbbb-2222-2222-2222-222222222222";

  for (const id of [first, second]) {
    const file = recordFile(WORK, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}\n", "utf8");
    madeRecords.push(file);
  }

  await launchWith([
    {
      title: "一枚目",
      cwd: WORK,
      args: [],
      initialCommand: COMMAND,
      agent: "claude",
      sessionId: first,
    },
    {
      title: "二枚目",
      cwd: WORK,
      args: [],
      initialCommand: COMMAND,
      agent: "claude",
      sessionId: second,
    },
  ]);
  await waitForPaneCount(page, 2);

  await expect
    .poll(() => logByTitle("一枚目"), { timeout: 15_000 })
    .toContain(compact(`echo --resume ${first}`));
  await expect
    .poll(() => logByTitle("二枚目"), { timeout: 15_000 })
    .toContain(compact(`echo --resume ${second}`));

  // **取り違えていないこと。** 同じディレクトリなので、ここが肝。
  // 端末の記録ではなくセッションが持つ id で見る（記録には履歴の候補が混ざる）
  const held = await electronApp.evaluate(() =>
    Object.fromEntries(
      global.__sessionManager.list().map((s: any) => [s.title, s.sessionId])
    )
  );
  expect(held).toEqual({ 一枚目: first, 二枚目: second });
});

/**
 * 復元で振り直した id を**保存する**（#33）。
 *
 * ここを忘れると、死んだ id が構成に残り続け、**毎回それを試して毎回
 * 新しい会話で立てる** —— そのペインは永久に再開できない。
 *
 * **実機で見つかった。** 受付ペインだけ復元されず、他は通る、という形で
 * 出た（受付の保存 id の記録が無かったため）。
 */
test("記録の無い id で立て直したら、新しい id を保存する", async () => {
  const dead = "deaddead-1111-2222-3333-444444444444";

  await launchWith([
    { cwd: WORK, args: [], initialCommand: COMMAND, agent: "claude", sessionId: dead },
  ]);
  await waitForPaneCount(page, 1);
  await expect.poll(() => logOf(0), { timeout: 15_000 }).toContain("--session-id");

  // 構成に書かれた id が、立て直した後のものになっていること
  await expect
    .poll(
      () => {
        const saved = JSON.parse(fs.readFileSync(RESTORE_PATH, "utf8"));
        return saved.sessions[0].sessionId;
      },
      { timeout: 10_000 }
    )
    .not.toBe(dead);

  const saved = JSON.parse(fs.readFileSync(RESTORE_PATH, "utf8"));
  expect(saved.sessions[0].sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  );
});

/** 再開したペインは、その id を持ち続ける（振り直さない） */
test("再開したペインの id は変わらない", async () => {
  const id = "33333333-4444-5555-6666-777777777777";
  const file = recordFile(WORK, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}\n", "utf8");
  madeRecords.push(file);

  await launchWith([
    { cwd: WORK, args: [], initialCommand: COMMAND, agent: "claude", sessionId: id },
  ]);
  await waitForPaneCount(page, 1);
  await expect.poll(() => logOf(0), { timeout: 15_000 }).toContain(compact(id));

  const saved = JSON.parse(fs.readFileSync(RESTORE_PATH, "utf8"));
  expect(saved.sessions[0].sessionId).toBe(id);
});
