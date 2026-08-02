const fs = require("fs");
const path = require("path");

/** ワークスペースファイルの形式バージョン */
const WORKSPACE_VERSION = 1;

const DEFAULT_NAME = "workspace";

/**
 * 実行中のセッション一覧を、復元に必要な情報だけの形に落とす。
 *
 * id や status といった実行時の情報は保存しない（次回は別の id で起動するため）。
 *
 * @param {object[]} sessions SessionManager.list() のスナップショット
 * @param {{name?: string}} [options]
 */
function serializeWorkspace(sessions, { name } = {}) {
  return {
    version: WORKSPACE_VERSION,
    name: name || DEFAULT_NAME,
    sessions: (sessions ?? []).map((s) => ({
      title: s.title,
      cwd: s.cwd,
      shell: s.shell,
      args: Array.isArray(s.args) ? s.args : [],
    })),
  };
}

/**
 * ワークスペース JSON を読み、復元に使える形に正規化する。
 *
 * 壊れたエントリ（cwd 無し）は捨て、未知のフィールドは持ち込まない。
 *
 * @param {string} text
 * @returns {{version: number, name: string, sessions: object[]}}
 * @throws {Error} JSON が壊れている / 形式が違う / バージョンが新しすぎる場合
 */
function parseWorkspace(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`ワークスペースの JSON を解析できません: ${err.message}`);
  }

  if (!raw || typeof raw !== "object") {
    throw new Error("ワークスペースの形式が不正です");
  }

  if (Number(raw.version) > WORKSPACE_VERSION) {
    throw new Error(
      `ワークスペースのバージョン ${raw.version} はこのアプリ (${WORKSPACE_VERSION}) より新しいため読み込めません`
    );
  }

  if (!Array.isArray(raw.sessions)) {
    throw new Error("ワークスペースに sessions 配列がありません");
  }

  return {
    version: Number(raw.version) || WORKSPACE_VERSION,
    name: raw.name || DEFAULT_NAME,
    sessions: raw.sessions
      .filter((s) => s && typeof s.cwd === "string" && s.cwd !== "")
      .map((s) => ({
        title: s.title,
        cwd: s.cwd,
        shell: s.shell,
        args: Array.isArray(s.args) ? s.args : [],
      })),
  };
}

/**
 * ワークスペースをファイルに保存する（親ディレクトリが無ければ作る）。
 */
function saveWorkspace(filePath, sessions, options = {}) {
  const workspace = serializeWorkspace(sessions, options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(workspace, null, 2), "utf8");
  return workspace;
}

/**
 * ワークスペースファイルを読み込む。
 * @throws {Error} ファイルが無い / 形式が不正な場合
 */
function loadWorkspace(filePath) {
  return parseWorkspace(fs.readFileSync(filePath, "utf8"));
}

module.exports = {
  WORKSPACE_VERSION,
  serializeWorkspace,
  parseWorkspace,
  saveWorkspace,
  loadWorkspace,
};
