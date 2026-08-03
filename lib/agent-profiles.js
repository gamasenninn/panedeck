/**
 * エージェントプロファイル。
 *
 * 「表示名 / 既定の起動コマンド / 入力待ちの判定パターン」を 1 組にしたもの。
 * PaneDeck は特定のエージェントに依存しない設計なので、状態判定も起動コマンドと
 * セットで差し替えられるようにここへ集約する。
 *
 * 状態を持たない定義とルックアップだけ。Electron にも pty にも依存しない。
 */

const { WAITING_PATTERNS } = require("./status-detector");

/**
 * エージェントを問わず現れる入力待ちの形。
 *
 * 確認プロンプトや選択肢はどの CLI でもほぼ同じ見た目になるので、
 * これを土台に各プロファイル固有のパターンを足す。
 */
const COMMON_WAITING_PATTERNS = [
  /❯/, // 選択肢プロンプト
  /\(y\/n\)/i, // 確認プロンプト
  /\[y\/n\]/i,
  /press enter/i,
];

/**
 * 同梱するプロファイル。
 *
 * claude のパターンは status-detector の既定をそのまま使う。ここがずれると
 * 「エージェントを指定しなかったとき」と「claude を選んだとき」で判定が
 * 変わってしまうため、複製せず参照する。
 *
 * codex / gemini は共通パターンのみ。各 CLI 固有の入力ボックス表示は実機で
 * 確認できていないので、確かめたものだけを足していくこと。当て推量の正規表現を
 * 入れると誤判定（実行中を入力待ちと見なす）が起きて主機能の信頼性が落ちる。
 */
const AGENT_PROFILES = [
  {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    waitingPatterns: WAITING_PATTERNS,
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    waitingPatterns: COMMON_WAITING_PATTERNS,
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    command: "gemini",
    waitingPatterns: COMMON_WAITING_PATTERNS,
  },
  {
    id: "shell",
    name: "シェル",
    command: "",
    waitingPatterns: COMMON_WAITING_PATTERNS,
  },
];

/** 未指定・未知の id はこれにフォールバックする（改名前からの挙動を保つ） */
const DEFAULT_AGENT_ID = "claude";

/**
 * レンダラへ渡せる形のプロファイル一覧。
 *
 * 正規表現は structured clone を通らず IPC に載せられないため、判定に使う
 * `waitingPatterns` は落として id / name / command だけを返す。判定は
 * メインプロセス側で行うので、レンダラが正規表現を持つ必要はない。
 *
 * @returns {{id: string, name: string, command: string}[]}
 */
function listProfiles() {
  return AGENT_PROFILES.map(({ id, name, command }) => ({ id, name, command }));
}

/**
 * id からプロファイルを引く。未知・未指定なら既定を返す。
 *
 * 呼び出し側で存在確認をしなくて済むよう、必ずプロファイルを返す。
 *
 * @param {unknown} [id]
 * @returns {{id: string, name: string, command: string, waitingPatterns: RegExp[]}}
 */
function resolveProfile(id) {
  const found =
    typeof id === "string"
      ? AGENT_PROFILES.find((profile) => profile.id === id)
      : undefined;

  return found ?? AGENT_PROFILES.find((profile) => profile.id === DEFAULT_AGENT_ID);
}

module.exports = {
  AGENT_PROFILES,
  COMMON_WAITING_PATTERNS,
  DEFAULT_AGENT_ID,
  listProfiles,
  resolveProfile,
};
