const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const pty = require("node-pty");

const { SessionManager } = require("./lib/session-manager");
const { saveWorkspace, loadWorkspace } = require("./lib/workspace");

let mainWindow;

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

sessionManager.onData((id, data) => sendToRenderer("session:data", { id, data }));
sessionManager.onExit((id, exitCode) =>
  sendToRenderer("session:exit", { id, exitCode })
);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#0d1117",
    title: "ClaudeDeck",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile("index.html");
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  sessionManager.closeAll();
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
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
    });

    // 起動直後に流し込むコマンド（例: "claude"）
    if (options.initialCommand) {
      sessionManager.write(session.id, `${options.initialCommand}\r`);
    }

    return { ok: true, session };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("session:list", () => sessionManager.list());

ipcMain.handle("session:close", (_, id) => sessionManager.close(id));

ipcMain.handle("session:closeAll", () => sessionManager.closeAll());

ipcMain.handle("session:broadcast", (_, { data, ids }) =>
  sessionManager.broadcast(data, ids)
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
    defaultPath: "claudedeck-workspace.json",
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
    const created = workspace.sessions.map((entry) => {
      const session = sessionManager.create(entry);
      if (options.initialCommand) {
        sessionManager.write(session.id, `${options.initialCommand}\r`);
      }
      return session;
    });
    return { ok: true, name: workspace.name, sessions: created };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
