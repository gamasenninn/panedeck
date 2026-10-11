import { app, BrowserWindow, ipcMain, dialog, clipboard } from "electron";
import path from "path";
import fs from "fs";
import os from "os";
import * as pty from "node-pty";

import type {
  CreateSessionOptions,
  Session,
  Pty,
  PtyFactoryOptions,
  Settings,
  WorkspaceEntry,
  OpenFolder,
} from "./types/panedeck";
import { SessionManager } from "./lib/session-manager";
import { saveWorkspace, loadWorkspace, tryLoadWorkspace } from "./lib/workspace";
import { listProfiles, resolveProfile } from "./lib/agent-profiles";
import { TriggerWatcher } from "./lib/trigger-watcher";
import { desiredMailboxes } from "./lib/mailbox";
import { BuildWatch } from "./lib/build-watch";
import { createScreen } from "./lib/screen";
import { resumePlan, shouldRetryFresh } from "./lib/resume-plan";
import { ServiceRunner } from "./lib/service-runner";
import { spawnService } from "./lib/spawn-service";
import { folderFromArgv } from "./lib/open-folder";
import { secondLaunchNotice } from "./lib/second-launch";
import { readSettings, updateSettings } from "./lib/settings";
import { LogWriter, type LogFailure } from "./lib/log-writer";
import { EventLog } from "./lib/event-log";
import { cleanupLogs } from "./lib/log-retention";

let mainWindow: BrowserWindow | null = null;

/**
 * 設定ファイルの場所。
 *
 * 環境変数で差し替えられるようにしてあるのは E2E のため。レンダラは起動直後に
 * 設定を読むので、起動後に注入する方式では初回の読み込みに間に合わない。
 * また、アプリを再起動するテストでも同じ場所を指し続けられる。
 */
function settingsPath(): string {
  return (
    process.env.PANEDECK_SETTINGS_PATH ||
    path.join(app.getPath("userData"), "settings.json")
  );
}

/**
 * 自動復元用の構成ファイル。設定ファイルと同じ場所に置く。
 *
 * こうしておくと保存先の差し替えが 1 つで済み、テストが実ユーザーの
 * userData を汚さない。ユーザーが明示的に保存するワークスペースとは別物で、
 * こちらはセッションの増減のたびに黙って上書きされる。
 */
function autoRestorePath(): string {
  return path.join(path.dirname(settingsPath()), "last-session.json");
}

/**
 * 全終了の直前の構成（2026-10-09）。**1 つだけ**持つ。
 *
 * 全終了は控え（last-session.json）を空で上書きするので、押し通すと会話の id
 * ごと、どのペインがどの会話だったかを忘れる。ここに残しておき、空の画面から
 * 人が押したときだけ戻す。**自動では戻さない**（全部閉じたら次は空のまま）
 */
function previousPath(): string {
  return path.join(path.dirname(settingsPath()), "last-session.previous.json");
}

/** ログの出力先。設定が空なら設定ファイルと同じ場所の logs/ */
function logDir(): string {
  return (
    readSettings(settingsPath()).logDir ||
    path.join(path.dirname(settingsPath()), "logs")
  );
}

/**
 * 片付けの根拠になる索引。ログの出力先と同じ場所に置く。
 *
 * 出力先を変えると索引も別になる。前の出力先のログは片付かなくなるが、
 * 「消せない」方向に倒れるので実害は小さい。
 */
function logIndexPath(): string {
  return path.join(logDir(), ".panedeck-logs.json");
}

/**
 * 溜まったログを片付ける。
 *
 * 起動時に一度だけ。書き込みのたびに走査するのは重すぎる。
 * 索引に載っている＝PaneDeck が作ったファイルだけが対象で、出力先に置かれた
 * 他のファイルには触れない。
 */
function cleanupOldLogs(): void {
  const settings = readSettings(settingsPath());

  const result = cleanupLogs({
    indexPath: logIndexPath(),
    policy: {
      maxAgeDays: settings.logRetentionDays,
      maxTotalBytes: settings.logMaxTotalMB * 1024 * 1024,
    },
  });

  // 消せなかったものは次回また試すので、ここでは知らせない。
  // 起動のたびに通知が出るほうが煩わしい
  if (result.failed.length > 0) {
    console.warn(
      `古いログを ${result.failed.length} 件片付けられませんでした`,
      result.failed
    );
  }
}

/** ログの自動保存。無効なときは null。 */
let logWriter: LogWriter | null = null;

/** 溜まった出力を書き出す間隔 (ms) */
const LOG_FLUSH_MS = 300;

/**
 * トリガーがファイルを見にいく間隔 (ms)（#28）。
 *
 * **fs.watch は使わない。** Windows では取りこぼしと二重発火があり、
 * ネットワーク越しのファイルでは働かないこともある。ここで欲しいのは
 * 「数百 ms 以内に気づく」であって「即座に」ではないので、画面の同期と
 * 同じ周期で素直に見にいくほうが、取りこぼさないぶん確か。
 */
const TRIGGER_POLL_MS = 300;

/**
 * 出来事の記録（#36）。
 *
 * ペインの記録と**同じ場所・同じ索引**に置くので、保持期間の片付けに乗る。
 * 書けなくても配達は続ける（`EventLog` が投げない）。
 */
let eventLog: EventLog | null = null;

function events(): EventLog {
  if (!eventLog) {
    eventLog = new EventLog({ dir: logDir(), indexPath: logIndexPath() });
  }
  return eventLog;
}

/** 設定にトリガーが無ければ null のまま */
let triggerWatcher: TriggerWatcher | null = null;
let triggerTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 落ちたサービスを起こし直すか見にいく間隔 (ms)（#29）。
 *
 * 待ち時間は秒単位なので、この粗さで足りる。
 */
const SERVICE_TICK_MS = 1_000;

/** 設定にサービスが無ければ null のまま */
let serviceRunner: ServiceRunner | null = null;

/**
 * 失敗を通知して、それ以上溜め込まないようにする。
 *
 * LogWriter 側で失敗したセッションは書き込みを諦めるので、通知は
 * セッションごとに一度きりになる。
 */
function reportLogFailures(failures: LogFailure[]): void {
  for (const failure of failures) {
    sendToRenderer("log:error", failure);
  }
}

/** 設定に合わせてログの自動保存を開始・停止する。 */
function applyLogSettings(): void {
  const settings = readSettings(settingsPath());

  if (!settings.autoLog) {
    if (logWriter) reportLogFailures(logWriter.closeAll());
    logWriter = null;
    return;
  }

  // 出力先や ANSI の扱いが変わることもあるので、有効化のたびに作り直す。
  // 既に開いているセッションは新しいファイルへ続きを書く
  if (logWriter) logWriter.closeAll();
  logWriter = new LogWriter({
    dir: logDir(),
    stripAnsi: settings.logStripAnsi,
    indexPath: logIndexPath(),
  });

  for (const session of sessionManager.list()) {
    logWriter.open(session.id, session.title);
  }
}

/**
 * 現在のセッション構成を自動保存する。
 *
 * 失敗しても投げない。これは利便のための控えであって、書けなかったからといって
 * セッションの生成や終了そのものを失敗させるべきではない。明示的な
 * 「構成を保存」は従来どおり失敗を呼び出し側へ返す。
 */
/**
 * 起動時の復元で**開けなかった**ペイン（2026-10-10）。控えに書き戻し続ける。
 *
 * 以前は失敗を握りつぶし、開けた分だけで控えを書いていた。全部失敗すると
 * 0 枚で書き、**控えが消えた**（Mac セッションが踏んだ）。ここに残しておけば、
 * 後でペインを足したり閉じたりして控えを書き直しても消えず、次の起動でまた試せる
 */
let unopened: WorkspaceEntry[] = [];

/**
 * 控えの 1 行からペインを開く。**開けなければ黙って捨てない**（2026-10-10）:
 * 理由を記録と stderr に残し（画面の見えない人にも読める）、控えにも残す。
 * 1 つのディレクトリが消えていても、残りは開く
 */
function openOrKeep(entry: WorkspaceEntry): Session | null {
  try {
    return openFromEntry(entry);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    unopened.push(entry);
    events().write({ kind: "restore-failed", title: entry.title, cwd: entry.cwd, reason });
    process.stderr.write(`[restore-failed] ${entry.title ?? ""} (${entry.cwd}): ${reason}\n`);
    return null;
  }
}

function persistSessions(): void {
  try {
    saveWorkspace(autoRestorePath(), [...sessionManager.list(), ...unopened], {
      name: "last-session",
    });
  } catch {
    // 控えが残らないだけなので、起動中の操作は続行させる
  }
}

/**
 * 前回の構成を復元する。
 *
 * 設定で無効なら何もしない。ファイルが無い・壊れているときも黙って諦める
 * （初回起動では必ず「無い」を通る）。
 */
function restoreLastSession(): void {
  if (!readSettings(settingsPath()).autoRestore) return;

  const workspace = tryLoadWorkspace(autoRestorePath());
  if (!workspace) return;

  for (const entry of workspace.sessions) openOrKeep(entry);

  // **振り直した会話の id をここで残す（#33）。**
  //
  // 忘れると、記録の無い id が構成に残り続け、毎回それを試して毎回新しい
  // 会話で立てることになる —— **そのペインは永久に再開できない**。
  // 実機で踏んだ: 受付ペインだけ復元されず、他は通る、という形で出た
  persistSessions();
}

/**
 * 保存された 1 行からペインを開く（#33）。
 *
 * **自動復元と手動の復元で同じ判断を通す。** 片方だけに置くと、手で選んだ
 * 構成が記録の無い会話を再開しようとして落ちる（実際にそうなっていた）。
 */
function openFromEntry(entry: WorkspaceEntry): Session {
  const plan = resumePlan({
    entry,
    profile: resolveProfile(entry.agent),
    exists: (file) => fs.existsSync(file),
  });
  const session = sessionManager.create({ ...entry, ...plan });
  // 再開で起こしたものだけ、落ちたときの立て直しを見張る
  if (plan.resume) watchResume(session.id, entry);
  // どちらで起こしたかを残す（#36）。会話が新しくなった理由が後から分かる
  events().write({
    kind: plan.resume ? "resumed" : "fresh-conversation",
    title: session.title,
    sessionId: session.sessionId ?? null,
    savedId: entry.sessionId ?? null,
  });
  return session;
}

/**
 * 再開で起こしたペインが落ちたら、**1 回だけ**新しい会話で立て直す（#33）。
 *
 * 記録を調べても再開が失敗することはある（記録はあるが読めない、など）。
 * ただし**繰り返してはいけない** —— 本当に壊れているコマンドだと、
 * 立て直しの輪に入る。
 */
function watchResume(id: string, entry: WorkspaceEntry): void {
  pendingResumes.set(id, { entry, at: Date.now() });
}

/**
 * 再開で起こしたペインが落ちたなら、新しい会話で立て直す。
 *
 * **1 回だけ。** 立て直したペインは見張りから外すので、輪には入らない。
 */
function retryWithoutResume(id: string, exitCode: number): void {
  const pending = pendingResumes.get(id);
  if (!pending) return;
  pendingResumes.delete(id);

  // 判断は lib/ 側。ここは起こし直すだけ
  if (!shouldRetryFresh({ exitCode, msSinceLaunch: Date.now() - pending.at })) return;

  try {
    sessionManager.close(id);
    // **新しい会話で。** 同じ id で起こし直しても、また同じ理由で落ちる
    sessionManager.create({ ...pending.entry, sessionId: undefined, resume: false });
    events().write({
      kind: "resume-failed",
      title: pending.entry.title ?? null,
      savedId: pending.entry.sessionId ?? null,
      exitCode,
    });
    // **振り直した id を残す（#33 と同じ穴）。** 残さないと、次の起動も
    // 同じ死んだ id を試して失敗し、起動をまたいで永久に繰り返す
    persistSessions();
  } catch {
    // 立て直せなくても、残りのペインは動かし続ける
  }
}

/** 再開で起こしたペイン。落ちたら 1 回だけ立て直す */
const pendingResumes = new Map<string, { entry: WorkspaceEntry; at: number }>();

// 「すぐ」の線引きは lib/resume-plan.ts（RESUME_FAILED_MS）。
// 判断を 2 箇所に置かない

/** OS 既定のシェル */
function defaultShell(): string {
  if (process.platform === "win32") return "powershell.exe";
  return process.env.SHELL || "bash";
}

/**
 * node-pty でプロセスを起動する。SessionManager にはこの関数だけを渡すので、
 * テストではフェイクに差し替えられる。
 */
function realPtyFactory({ shell, args, cwd, cols, rows, env }: PtyFactoryOptions): Pty {
  const spawned = pty.spawn(shell || defaultShell(), args || [], {
    name: "xterm-color",
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd || os.homedir(),
    env: { ...process.env, ...env } as Record<string, string>,
  });
  return process.env.PANEDECK_TRACE_PTY === "1" ? tracePty(spawned) : spawned;
}

/**
 * pty の操作を stderr に書く（#38 の調べ用。`PANEDECK_TRACE_PTY=1` のときだけ）。
 *
 * 全体試験の中でだけ、立ち上げ直した PaneDeck が**アクセス違反（0xC0000005）で
 * 落ちる**。直前に「もう居ないシェルへの kill」が走っている。JS の例外ではない
 * ので、**どの操作の直後に落ちたか**を残さないと追えない
 */
function tracePty(target: Pty): Pty {
  const pid = target.pid;
  const alive = () => {
    if (pid === undefined) return "?";
    try {
      process.kill(pid, 0);
      return "生";
    } catch {
      return "死";
    }
  };
  const log = (what: string) =>
    process.stderr.write(`[pty ${new Date().toISOString().slice(11, 23)}] ${what} pid=${pid} (${alive()})\n`);
  log("spawn");
  target.onExit(({ exitCode }) => log(`onExit code=${exitCode}`));
  const kill = target.kill.bind(target);
  const resize = target.resize.bind(target);
  target.kill = () => {
    log("kill 前");
    kill();
    log("kill 後");
  };
  target.resize = (cols: number, rows: number) => {
    log(`resize ${cols}x${rows} 前`);
    resize(cols, rows);
    log("resize 後");
  };
  return target;
}

const sessionManager = new SessionManager({
  ptyFactory: realPtyFactory,
  // 判定は記録の末尾ではなく画面を見る（#31）
  screenFactory: createScreen,
});

// E2E テストから ptyFactory を差し替えられるように公開する
globalThis.__sessionManager = sessionManager;

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

sessionManager.onData((id, data) => {
  sendToRenderer("session:data", { id, data });
  // 書き込みはここでは行わない。pty の出力は高頻度なので、溜めて定期的に流す
  logWriter?.append(id, data);
});
sessionManager.onExit((id, exitCode) => {
  sendToRenderer("session:exit", { id, exitCode });
  // 再開に失敗したペインを、新しい会話で立て直す（#33）
  retryWithoutResume(id, exitCode);
});

/**
 * 設定のトリガーを起こす（#28）。
 *
 * 送るのは **指示待ちのペインだけ**。ペインは題で指す（作業ディレクトリは
 * 複数のペインで重なりうる）。どこまで届けたかは設定に預けてあるので、
 * 閉じている間に増えた行も次の起動で届く。
 */
/** 郵便受けの置き場所（#34）。設定・ログ・復元の控えと同じ場所に並ぶ */
function mailboxDir(): string {
  return path.join(path.dirname(settingsPath()), "mailbox");
}

/**
 * いま開いているペインの題と、郵便受けのトリガーを突き合わせる（#34、2026-10-10）。
 *
 * 足りないものは**ファイルを空で作ってから**足し（無いと「読めません」が出る）、
 * 要らなくなったもの（閉じた・題を変えた）は外す。外しても TriggerWatcher が
 * カーソルを覚えているので、開き直せば閉じている間の便も届く
 */
function syncMailboxes(
  watcher: TriggerWatcher,
  auto: Set<string>,
  manual: string[],
  persisted: Record<string, number>,
  sessions: Session[]
): void {
  const desired = desiredMailboxes({
    titles: sessions.map((session) => session.title ?? ""),
    dir: mailboxDir(),
    taken: manual,
  });
  const want = new Map(desired.map((config) => [config.watch, config]));

  for (const watch of [...auto]) {
    if (want.has(watch)) continue;
    watcher.remove(watch);
    auto.delete(watch);
  }
  for (const [watch, config] of want) {
    if (auto.has(watch)) continue;
    try {
      fs.mkdirSync(path.dirname(watch), { recursive: true });
      // 追記で開くので、既にあれば中身はそのまま（作るだけ）
      fs.appendFileSync(watch, "", "utf8");
    } catch {
      continue; // 作れなければ見張らない。次の周でまた試す
    }
    watcher.add(config, persisted[watch]);
    auto.add(watch);
  }
}

/**
 * この見回りで取った一覧。**見回り 1 回につき 1 回だけ**作り、郵便受けの
 * 突き合わせと全トリガーで使い回す（20 ペインで 22 回 → 1 回）
 */
let tickSessions: Session[] = [];

function startTriggers(): void {
  const settings = readSettings(settingsPath());
  if (settings.triggers.length === 0 && !settings.mailboxes) return;

  triggerWatcher = new TriggerWatcher({
    // **一覧は見回りごとに 1 回だけ。** 届け先を探すたびに作り直すと、
    // 全ペインの画面を読む判定がトリガー数 × ペイン数だけ走る
    listPanes: () =>
      tickSessions.map((session) => ({
        id: session.id,
        title: session.title,
        status: session.status,
      })),
    // 確定の CR はここで付ける。ひな型に改行を書かせない（#28 の信頼境界）
    // **打つことと確定することは別の出来事。** 一度にまとめて書くと
    // Claude Code は貼り付けと見て CR を改行にし、文面が入力欄に残る。
    // 間隔と押し直しは TriggerWatcher が時計で決める
    type: (id, text) => sessionManager.write(id, text),
    submit: (id) => sessionManager.write(id, "\r"),
    // **見せるだけでは残らない（#36）。** ツールバーは「いま」を描くだけで、
    // 直れば証拠が消え、閉じれば全部消える
    onEvent: (event) => events().write(event),
  });

  for (const trigger of settings.triggers) {
    triggerWatcher.add(trigger, settings.triggerCursors[trigger.watch]);
  }

  const manual = settings.triggers.map((trigger) => trigger.watch);
  const autoMailboxes = new Set<string>();

  // ★ **設定に実際に書かれている位置**と比べる。見張り始めた位置と比べると、
  // 一度も配らないトリガーは位置を保存しないまま終わり、再起動のたびに「今の末尾から」
  // 見張り直して、その間に書かれた行を永久に配らない（Mac セッションが踏んだ）
  let saved = JSON.stringify(settings.triggerCursors);
  triggerTimer = setInterval(() => {
    if (!triggerWatcher) return;
    tickSessions = sessionManager.list();
    if (settings.mailboxes) {
      syncMailboxes(triggerWatcher, autoMailboxes, manual, settings.triggerCursors, tickSessions);
    }
    triggerWatcher.check();

    // 進んだときだけ書く。毎周書くと設定ファイルを叩き続けることになる
    const now = JSON.stringify(triggerWatcher.cursors());
    if (now === saved) return;
    try {
      updateSettings(settingsPath(), { triggerCursors: JSON.parse(now) });
      // **書けてから覚える。** 先に覚えると、失敗したときに二度と書き直さず、
      // 設定には古いカーソルが残る —— 次の起動で**同じ便がもう一度配達される**。
      // 覚えるのを後にすれば、次の周で書き直す
      saved = now;
    } catch {
      // 書けなかっただけ。配達そのものは続け、次の周でもう一度試す
    }
  }, TRIGGER_POLL_MS);
}

/**
 * 設定のサービスを起こす（#29）。
 *
 * 出力はログに溜めるだけで、ペインへは流さない。ペインへ伝えるのは
 * ファイルを見ているトリガーの仕事（#28）。
 */
function startServices(): void {
  const settings = readSettings(settingsPath());
  if (settings.services.length === 0) return;

  serviceRunner = new ServiceRunner({
    // 開いたフォルダで動かす。相対パスのコマンドがそこで解決される（2026-10-11）
    spawn: (command) => spawnService(command, { cwd: openFolder.folder }),
    // 復帰すると表示から消えるので、ここで残す（#36）
    onEvent: (event) => events().write(event),
  });
  serviceRunner.start(settings.services);
  setInterval(() => serviceRunner?.tick(), SERVICE_TICK_MS);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#0d1117",
    title: "PaneDeck",
    // パッケージ版は electron-builder が実行ファイルに埋め込むが、
    // npm start で動かしているときはここで指定しないと既定のままになる
    icon: path.join(app.getAppPath(), "build", "icon.png"),

    // Electron には Chromium のような真のヘッドレスが無い。E2E では
    // **画面の外へ出す**（隠すのではない）。
    //
    // `show: false` にすると Chromium がフレームを作らなくなり、Playwright の
    // 安定性チェックが毎回待たされて実行時間が 6 倍以上に膨らんだ。
    // 省電力系のスイッチを切っても変わらない。画面外なら描画は続くので、
    // 目に触れないことと速さを両立できる
    ...(process.env.PANEDECK_HIDE_WINDOW === "1"
      ? { x: -4000, y: -4000, skipTaskbar: true }
      : {}),

    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,

      // 背景に回してもタイマーを間引かせない。
      //
      // このアプリは「どのペインが止まっているか」を 300ms ポーリングで
      // 追うので、間引かれると別の作業をしている間ほど状態が古くなる。
      // 見張るためのアプリが、見ていないときに更新を止めては本末転倒。
      backgroundThrottling: false,
    },
  });

  // ビルド後は main が dist/ に居るので、アプリのルートから辿る
  mainWindow.loadFile(path.join(app.getAppPath(), "index.html"));
}

app.whenReady().then(() => {
  // 起動したときのビルドの中身を、ここで覚える（後から読むと、書き換え後を覚えてしまう）
  buildWatch = new BuildWatch(
    process.env.PANEDECK_BUILD_DIR || path.join(app.getAppPath(), "dist")
  );
  // ウィンドウより先に復元する。レンダラは一覧をポーリングして追従し、
  // それまでの出力は各セッションのログに溜まって初回描画時に流し込まれる
  restoreLastSession();
  // 新しいログを開く前に片付ける（今から書くものを対象にしない）
  cleanupOldLogs();
  applyLogSettings();
  createWindow();

  setInterval(() => {
    if (logWriter) reportLogFailures(logWriter.flush());
  }, LOG_FLUSH_MS);

  startTriggers();
  startServices();
});

/**
 * トリガーを止める。**ペインを畳む前に呼ぶこと。**
 *
 * 先にペインを畳むと、プロセスが消えるまでの間に見回りが走り、
 * 「ペインがありません」を記録する。実機では閉じるたびに毎回出ていた
 * （本物の pty は後始末に時間がかかり、その間に何周も入る）。後から 1 日を
 * 読むための記録に偽の失敗が混ざり、「直った」も対で出ないので、失敗した
 * まま終わったように読める
 */
function stopTriggers(): void {
  if (triggerTimer) clearInterval(triggerTimer);
  triggerTimer = null;
  triggerWatcher = null;
}

/**
 * kill の順番待ちが済むまで待つ上限 (ms)（#38）。
 *
 * kill は 1 本ずつ流れる（SessionManager）。待たずに終わると、まだ kill して
 * いないシェルが残り、kill の最中に終わると閉じきらずに固まることもあった。
 * ただし onExit が届かなくても**終わらないことは無いように**、上限を置く
 */
const QUIT_DRAIN_MS = 5_000;

function drainKills(): Promise<void> {
  return Promise.race([
    sessionManager.drained(),
    new Promise<void>((resolve) => setTimeout(resolve, QUIT_DRAIN_MS)),
  ]);
}

/** 順番待ちを待ち終えたか。will-quit を一度だけ引き止めるため */
let drainedForQuit = false;

app.on("window-all-closed", () => {
  stopTriggers();
  // 書き残しを先に吐き出してからセッションを畳む
  logWriter?.closeAll();
  sessionManager.closeAll();
  // 裏のコマンドも道連れにする。残すと、閉じたのに動き続ける（#29）
  serviceRunner?.stopAll();
  if (process.platform !== "darwin") {
    void drainKills().then(() => {
      drainedForQuit = true;
      app.quit();
    });
  }
});

app.on("will-quit", (event) => {
  stopTriggers();
  logWriter?.closeAll();
  sessionManager.closeAll();
  // window-all-closed を通らない終わり方（macOS の終了など）でも必ず止める
  serviceRunner?.stopAll();

  // ★ kill の順番待ちが済むまで引き止める（#38）。一度待ったら通す。
  // **引き止めた後は `app.exit()` で終える。** `app.quit()` で終わり直そうと
  // すると、閉じずに固まった（Playwright の close も返らなくなった）
  if (!drainedForQuit) {
    event.preventDefault();
    void drainKills().then(() => {
      drainedForQuit = true;
      app.exit(0);
    });
  }
});

/** ダイアログの親。まだウィンドウが無い場面では渡さない */
function parentWindow(): BrowserWindow {
  return mainWindow!;
}

// --- セッション ---

ipcMain.handle("session:create", (_, options: CreateSessionOptions = {}) => {
  try {
    const session = sessionManager.create({
      cwd: options.cwd,
      shell: options.shell,
      args: options.args,
      title: options.title,
      cols: options.cols,
      rows: options.rows,
      // 起動直後に流し込むコマンド（例: "claude"）。SessionManager が保持し、
      // 起動時の書き込みも担うので、ここでは渡すだけでよい
      initialCommand: options.initialCommand,
      // 入力待ちの判定パターンを決めるプロファイル id
      agent: options.agent,
    });

    logWriter?.open(session.id, session.title);
    persistSessions();
    return { ok: true, session };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle("session:list", () => sessionManager.list());

// 判定に使う正規表現は含まない（IPC に載らないため）。判定はメイン側で行う
ipcMain.handle("agent:list", () => listProfiles());

/** トリガーの様子（保留件数・届かない理由）。画面に出すためだけのもの（#28） */
ipcMain.handle("trigger:list", () => triggerWatcher?.state() ?? []);

/**
 * 動いているのが古いビルドか（2026-10-10）。修正のたびに再起動して、新しいビルドで
 * 動いているかを道具で確かめていた。**中身で比べる**（試験のビルドで日時だけ変わっても
 * 出ない）。見る場所は E2E のために差し替えられる
 */
let buildWatch: BuildWatch | null = null;

/**
 * 起動の引数で開いたフォルダ（2026-10-11）。VS Code の `code <フォルダ>` と同じ考えで、
 * 新しいペインも裏のコマンドもそこで動く。起動のあいだは変わらない
 */
const openFolder = folderFromArgv(process.argv, {
  defaultApp: Boolean(process.defaultApp),
  isDirectory: (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
});
ipcMain.handle("app:openFolder", () => openFolder);

/**
 * 2 つ目の PaneDeck は起動しない（2026-10-11）。
 *
 * 2 つ目は同じ設定を読むので、前回の構成を復元して**同じ会話を二重に再開し**、
 * 裏のコマンドもトリガーも二重に動く。2 つ目はすぐに終わり、1 つ目が前に出て知らせる。
 *
 * ★ 鍵は**設定の場所ごと**（Electron の鍵は userData ごと）。設定の場所を差し替えて
 * いるとき（E2E）は userData もそこへ寄せる。寄せないと、E2E のアプリが開発者の
 * 動かしている PaneDeck を「すでに動いている」と見て終わる
 */
if (process.env.PANEDECK_SETTINGS_PATH) {
  app.setPath("userData", path.dirname(process.env.PANEDECK_SETTINGS_PATH));
}
// 2 つ目が開こうとしたフォルダは、引数の並びに頼らず、2 つ目が自分で読んで渡す
if (!app.requestSingleInstanceLock({ ...openFolder })) {
  app.exit(0);
}
app.on("second-instance", (_event, _argv, _cwd, requested) => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  const samePath =
    process.platform === "win32"
      ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
      : undefined;
  mainWindow.webContents.send(
    "app:notice",
    secondLaunchNotice(openFolder, (requested ?? {}) as OpenFolder, samePath)
  );
});
ipcMain.handle("app:stale", () => {
  buildWatch ??= new BuildWatch(
    process.env.PANEDECK_BUILD_DIR || path.join(app.getAppPath(), "dist")
  );
  return buildWatch.stale();
});

/**
 * 上限で止めたトリガーを解除する（#34 の合意 ③）。**人が押したときだけ**。
 * 保留していた行は捨てていないので、次の見回りで 1 通にまとまって届く
 */
ipcMain.handle("trigger:release", (_event, watch: string) =>
  triggerWatcher ? triggerWatcher.release(String(watch)) : false
);

ipcMain.handle("service:list", () => serviceRunner?.state() ?? []);
ipcMain.handle("service:log", (_event, name: string) =>
  serviceRunner?.log(name) ?? ""
);

ipcMain.handle("session:close", (_, id: string) => {
  if (logWriter) reportLogFailures(logWriter.close(id));
  const closed = sessionManager.close(id);
  persistSessions();
  return closed;
});

ipcMain.handle("session:closeAll", () => {
  // **閉じる前に**控える。閉じてからでは一覧が空になっている
  // 開けなかったものも含めて控える（「直前の構成に戻す」でまた試せる）
  const before = [...sessionManager.list(), ...unopened];
  if (before.length > 0) {
    try {
      saveWorkspace(previousPath(), before, { name: "previous" });
    } catch {
      // 控えられないだけ。全終了そのものは止めない
    }
  }
  if (logWriter) reportLogFailures(logWriter.closeAll());
  const count = sessionManager.closeAll();
  // 全終了は「次は空で始めたい」という明示の操作。開けなかったものもここで手放す
  // （直前の控えには入れてある）
  unopened = [];
  persistSessions();
  return count;
});

/** 全終了の直前の構成が何個ぶん残っているか。無ければ 0 */
ipcMain.handle("workspace:previous", () => tryLoadWorkspace(previousPath())?.sessions.length ?? 0);

/**
 * 全終了の直前の構成に戻す。**自動復元と同じ経路**（会話の再開を含む・#33）。
 * 戻したら控えは消す —— 二度押すと同じペインが二重にできる
 */
ipcMain.handle("workspace:restorePrevious", () => {
  const workspace = tryLoadWorkspace(previousPath());
  if (!workspace) return { ok: false, error: "直前の構成がありません" };

  const created = workspace.sessions
    .map((entry) => openOrKeep(entry))
    .filter((session): session is Session => session !== null);
  for (const session of created) logWriter?.open(session.id, session.title);
  persistSessions();

  try {
    fs.rmSync(previousPath(), { force: true });
  } catch {
    // 消せなくても、戻せてはいる
  }
  return { ok: true, sessions: created };
});

ipcMain.handle("session:reorder", (_, ids: string[]) => {
  const ordered = sessionManager.reorder(ids);
  persistSessions();
  return ordered;
});

/**
 * ペインの題を付け替える（#28）。
 *
 * 題はトリガーの送り先を指すのに使う。構成にも保存されるので、
 * 付け替えたら控えを取り直す。
 */
ipcMain.handle("session:rename", (_, { id, title }: { id: string; title: string }) => {
  const renamed = sessionManager.rename(id, title);
  if (renamed) persistSessions();
  return renamed;
});

ipcMain.handle("session:broadcast", (_, { data, ids, options }) =>
  sessionManager.broadcast(data, ids, options)
);

ipcMain.on("session:input", (_, { id, data }) => {
  sessionManager.write(id, data);
});

ipcMain.on("session:resize", (_, { id, cols, rows }) => {
  sessionManager.resize(id, cols, rows);
});

ipcMain.handle("session:pickDirectory", async () => {
  const result = await dialog.showOpenDialog(parentWindow(), {
    title: "セッションを起動するディレクトリを選択",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// --- クリップボード ---

/**
 * 端末の選択範囲をコピーする。
 *
 * レンダラから直接クリップボードを触らせない。preload はサンドボックス下で
 * 動くので Electron の clipboard を import できず、`navigator.clipboard` も
 * file:// では扱いが不安定なため、メインプロセスに寄せる。
 */
ipcMain.handle("clipboard:write", (_, text: string) => {
  try {
    clipboard.writeText(String(text ?? ""));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

// --- 設定 ---

ipcMain.handle("settings:get", () => readSettings(settingsPath()));

ipcMain.handle("settings:set", (_, settings: Partial<Settings>) => {
  try {
    // 変更された項目だけが送られてくるので重ねて書く。
    // 書けた値をそのまま返し、レンダラは丸められた後の値を表示に使う
    const saved = updateSettings(settingsPath(), settings);
    applyLogSettings();
    return { ok: true, settings: saved };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

// --- ログ ---

ipcMain.handle("log:get", (_, id: string) => sessionManager.getLog(id));

ipcMain.handle("log:save", async (_, id: string) => {
  const session = sessionManager.get(id);
  if (!session) return { ok: false, error: "セッションが見つかりません" };

  const result = await dialog.showSaveDialog(parentWindow(), {
    title: "出力ログを保存",
    defaultPath: `${session.title}.log`,
    filters: [{ name: "Log", extensions: ["log", "txt"] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };

  try {
    fs.writeFileSync(result.filePath, sessionManager.getLog(id), "utf8");
    return { ok: true, filePath: result.filePath };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

// --- ワークスペース ---

ipcMain.handle("workspace:save", async (_, name: string) => {
  const result = await dialog.showSaveDialog(parentWindow(), {
    title: "セッション構成を保存",
    defaultPath: "panedeck-workspace.json",
    filters: [{ name: "Workspace", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };

  try {
    saveWorkspace(result.filePath, sessionManager.list(), { name });
    return { ok: true, filePath: result.filePath };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

/**
 * 保存した構成を復元する。
 *
 * **保存されたものをそのまま再現する。ツールバーの値では補わない（#26）。**
 * かつては起動コマンドを持たないエントリをツールバーの値で埋めていたが、
 * 保存側は空の起動コマンドを項目ごと省くため、「意図して素のシェル」と
 * 「古い形式で項目が無い」が同じ形になる。結果、シェルとして保存した
 * ペインが復元のたびに claude を起動していた。
 *
 * 自動復元（restoreLastSession）と同じ経路になったので、
 * 「どちらで戻したか」で結果が変わることも無くなる。
 */
ipcMain.handle("workspace:restore", async () => {
  const result = await dialog.showOpenDialog(parentWindow(), {
    title: "セッション構成を復元",
    properties: ["openFile"],
    filters: [{ name: "Workspace", extensions: ["json"] }],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, canceled: true };
  }

  try {
    const workspace = loadWorkspace(result.filePaths[0]);
    // 自動復元と**同じ判断を通す**（#33）。手で選んだ構成でも、記録が無い
    // 会話を再開しようとすれば同じように落ちる
    const created = workspace.sessions.map((entry) => openFromEntry(entry));
    for (const session of created) logWriter?.open(session.id, session.title);

    persistSessions();
    return { ok: true, name: workspace.name, sessions: created };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});
