const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deck", {
  // セッション
  createSession: (options) => ipcRenderer.invoke("session:create", options),
  listSessions: () => ipcRenderer.invoke("session:list"),
  closeSession: (id) => ipcRenderer.invoke("session:close", id),
  closeAllSessions: () => ipcRenderer.invoke("session:closeAll"),
  broadcast: (data, ids, options) =>
    ipcRenderer.invoke("session:broadcast", { data, ids, options }),
  pickDirectory: () => ipcRenderer.invoke("session:pickDirectory"),

  // エージェントプロファイル
  listAgents: () => ipcRenderer.invoke("agent:list"),

  // 高頻度の入力・リサイズは戻り値不要なので send/on
  input: (id, data) => ipcRenderer.send("session:input", { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send("session:resize", { id, cols, rows }),

  // Main → Renderer
  onSessionData: (cb) =>
    ipcRenderer.on("session:data", (_, { id, data }) => cb(id, data)),
  onSessionExit: (cb) =>
    ipcRenderer.on("session:exit", (_, { id, exitCode }) => cb(id, exitCode)),

  // 設定
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (settings) => ipcRenderer.invoke("settings:set", settings),

  // ログ
  getLog: (id) => ipcRenderer.invoke("log:get", id),
  saveLog: (id) => ipcRenderer.invoke("log:save", id),

  // ワークスペース
  saveWorkspace: (name) => ipcRenderer.invoke("workspace:save", name),
  restoreWorkspace: (options) => ipcRenderer.invoke("workspace:restore", options),
});
