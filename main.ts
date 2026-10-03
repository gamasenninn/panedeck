import { app, BrowserWindow, ipcMain, dialog, clipboard } from "electron";
import path from "path";
import fs from "fs";
import os from "os";
import * as pty from "node-pty";

import type {
  CreateSessionOptions,
  Pty,
  PtyFactoryOptions,
  Settings,
} from "./types/panedeck";
import { SessionManager } from "./lib/session-manager";
import { saveWorkspace, loadWorkspace, tryLoadWorkspace } from "./lib/workspace";
import { listProfiles } from "./lib/agent-profiles";
import { TriggerWatcher } from "./lib/trigger-watcher";
import { readSettings, updateSettings } from "./lib/settings";
import { LogWriter, type LogFailure } from "./lib/log-writer";
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

/** 設定にトリガーが無ければ null のまま */
let triggerWatcher: TriggerWatcher | null = null;

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
function persistSessions(): void {
  try {
    saveWorkspace(autoRestorePath(), sessionManager.list(), {
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

  for (const entry of workspace.sessions) {
    try {
      sessionManager.create(entry);
    } catch {
      // 1 つのディレクトリが消えていても、残りは開く
    }
  }
}

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
  return pty.spawn(shell || defaultShell(), args || [], {
    name: "xterm-color",
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd || os.homedir(),
    env: { ...process.env, ...env } as Record<string, string>,
  });
}

const sessionManager = new SessionManager({ ptyFactory: realPtyFactory });

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
sessionManager.onExit((id, exitCode) =>
  sendToRenderer("session:exit", { id, exitCode })
);

/**
 * 設定のトリガーを起こす（#28）。
 *
 * 送るのは **指示待ちのペインだけ**。ペインは題で指す（作業ディレクトリは
 * 複数のペインで重なりうる）。どこまで届けたかは設定に預けてあるので、
 * 閉じている間に増えた行も次の起動で届く。
 */
function startTriggers(): void {
  const settings = readSettings(settingsPath());
  if (settings.triggers.length === 0) return;

  triggerWatcher = new TriggerWatcher({
    findPane: (title) =>
      sessionManager
        .list()
        .filter((session) => session.title === title)
        .map((session) => ({
          id: session.id,
          title: session.title,
          status: session.status,
        })),
    // 確定の CR はここで付ける。ひな型に改行を書かせない（#28 の信頼境界）
    send: (id, text) => sessionManager.write(id, text + "\r"),
  });

  for (const trigger of settings.triggers) {
    triggerWatcher.add(trigger, settings.triggerCursors[trigger.watch]);
  }

  let saved = JSON.stringify(triggerWatcher.cursors());
  setInterval(() => {
    if (!triggerWatcher) return;
    triggerWatcher.check();

    // 進んだときだけ書く。毎周書くと設定ファイルを叩き続けることになる
    const now = JSON.stringify(triggerWatcher.cursors());
    if (now === saved) return;
    saved = now;
    try {
      updateSettings(settingsPath(), { triggerCursors: JSON.parse(now) });
    } catch {
      // 控えが残らないだけ。配達そのものは続ける
    }
  }, TRIGGER_POLL_MS);
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
});

app.on("window-all-closed", () => {
  // 書き残しを先に吐き出してからセッションを畳む
  logWriter?.closeAll();
  sessionManager.closeAll();
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  logWriter?.closeAll();
  sessionManager.closeAll();
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

ipcMain.handle("session:close", (_, id: string) => {
  if (logWriter) reportLogFailures(logWriter.close(id));
  const closed = sessionManager.close(id);
  persistSessions();
  return closed;
});

ipcMain.handle("session:closeAll", () => {
  if (logWriter) reportLogFailures(logWriter.closeAll());
  const count = sessionManager.closeAll();
  persistSessions();
  return count;
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
    const created = workspace.sessions.map((entry) => sessionManager.create(entry));
    for (const session of created) logWriter?.open(session.id, session.title);

    persistSessions();
    return { ok: true, name: workspace.name, sessions: created };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});
