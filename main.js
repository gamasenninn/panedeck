const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const pty = require("node-pty");

const { SessionManager } = require("./lib/session-manager");
const {
  saveWorkspace,
  loadWorkspace,
  tryLoadWorkspace,
} = require("./lib/workspace");
const { listProfiles } = require("./lib/agent-profiles");
const { readSettings, updateSettings } = require("./lib/settings");
const { LogWriter } = require("./lib/log-writer");

let mainWindow;

/**
 * 設定ファイルの場所。
 *
 * 環境変数で差し替えられるようにしてあるのは E2E のため。レンダラは起動直後に
 * 設定を読むので、起動後に注入する方式では初回の読み込みに間に合わない。
 * また、アプリを再起動するテストでも同じ場所を指し続けられる。
 */
function settingsPath() {
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
function autoRestorePath() {
  return path.join(path.dirname(settingsPath()), "last-session.json");
}

/** ログの出力先。設定が空なら設定ファイルと同じ場所の logs/ */
function logDir() {
  return (
    readSettings(settingsPath()).logDir ||
    path.join(path.dirname(settingsPath()), "logs")
  );
}

/**
 * ログの自動保存。無効なときは null。
 * @type {InstanceType<typeof LogWriter>|null}
 */
let logWriter = null;

/** 溜まった出力を書き出す間隔 (ms) */
const LOG_FLUSH_MS = 300;

/**
 * 失敗を通知して、それ以上溜め込まないようにする。
 *
 * LogWriter 側で失敗したセッションは書き込みを諦めるので、通知は
 * セッションごとに一度きりになる。
 */
function reportLogFailures(failures) {
  for (const failure of failures) {
    sendToRenderer("log:error", failure);
  }
}

/** 設定に合わせてログの自動保存を開始・停止する。 */
function applyLogSettings() {
  const settings = readSettings(settingsPath());

  if (!settings.autoLog) {
    if (logWriter) reportLogFailures(logWriter.closeAll());
    logWriter = null;
    return;
  }

  // 出力先や ANSI の扱いが変わることもあるので、有効化のたびに作り直す。
  // 既に開いているセッションは新しいファイルへ続きを書く
  if (logWriter) logWriter.closeAll();
  logWriter = new LogWriter({ dir: logDir(), stripAnsi: settings.logStripAnsi });

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
function persistSessions() {
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
function restoreLastSession() {
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
function defaultShell() {
  if (process.platform === "win32") return "powershell.exe";
  return process.env.SHELL || "bash";
}

/**
 * node-pty でプロセスを起動する。SessionManager にはこの関数だけを渡すので、
 * テストではフェイクに差し替えられる。
 */
function realPtyFactory({ shell, args, cwd, cols, rows, env }) {
  return pty.spawn(shell || defaultShell(), args || [], {
    name: "xterm-color",
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd || os.homedir(),
    env: { ...process.env, ...env },
  });
}

const sessionManager = new SessionManager({ ptyFactory: realPtyFactory });

// E2E テストから ptyFactory を差し替えられるように公開する
global.__sessionManager = sessionManager;

function sendToRenderer(channel, payload) {
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#0d1117",
    title: "PaneDeck",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile("index.html");
}

app.whenReady().then(() => {
  // ウィンドウより先に復元する。レンダラは一覧をポーリングして追従し、
  // それまでの出力は各セッションのログに溜まって初回描画時に流し込まれる
  restoreLastSession();
  applyLogSettings();
  createWindow();

  setInterval(() => {
    if (logWriter) reportLogFailures(logWriter.flush());
  }, LOG_FLUSH_MS);
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

// --- セッション ---

ipcMain.handle("session:create", (_, options = {}) => {
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
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("session:list", () => sessionManager.list());

// 判定に使う正規表現は含まない（IPC に載らないため）。判定はメイン側で行う
ipcMain.handle("agent:list", () => listProfiles());

ipcMain.handle("session:close", (_, id) => {
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

ipcMain.handle("session:reorder", (_, ids) => {
  const ordered = sessionManager.reorder(ids);
  persistSessions();
  return ordered;
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
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "セッションを起動するディレクトリを選択",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// --- 設定 ---

ipcMain.handle("settings:get", () => readSettings(settingsPath()));

ipcMain.handle("settings:set", (_, settings) => {
  try {
    // 変更された項目だけが送られてくるので重ねて書く。
    // 書けた値をそのまま返し、レンダラは丸められた後の値を表示に使う
    const saved = updateSettings(settingsPath(), settings);
    applyLogSettings();
    return { ok: true, settings: saved };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- ログ ---

ipcMain.handle("log:get", (_, id) => sessionManager.getLog(id));

ipcMain.handle("log:save", async (_, id) => {
  const session = sessionManager.get(id);
  if (!session) return { ok: false, error: "セッションが見つかりません" };

  const result = await dialog.showSaveDialog(mainWindow, {
    title: "出力ログを保存",
    defaultPath: `${session.title}.log`,
    filters: [{ name: "Log", extensions: ["log", "txt"] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };

  try {
    fs.writeFileSync(result.filePath, sessionManager.getLog(id), "utf8");
    return { ok: true, filePath: result.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- ワークスペース ---

ipcMain.handle("workspace:save", async (_, name) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "セッション構成を保存",
    defaultPath: "panedeck-workspace.json",
    filters: [{ name: "Workspace", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };

  try {
    saveWorkspace(result.filePath, sessionManager.list(), { name });
    return { ok: true, filePath: result.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("workspace:restore", async (_, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "セッション構成を復元",
    properties: ["openFile"],
    filters: [{ name: "Workspace", extensions: ["json"] }],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, canceled: true };
  }

  try {
    const workspace = loadWorkspace(result.filePaths[0]);
    const created = workspace.sessions.map((entry) =>
      sessionManager.create({
        ...entry,
        // セッションごとの値を優先し、持たないものはツールバーの値で補う。
        // 起動コマンドを持たない既存のワークスペースでも今までどおり動く
        initialCommand: entry.initialCommand || options.initialCommand,
        agent: entry.agent || options.agent,
      })
    );
    for (const session of created) logWriter?.open(session.id, session.title);

    persistSessions();
    return { ok: true, name: workspace.name, sessions: created };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
