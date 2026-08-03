/**
 * pty の出力からセッションの状態を判定する。
 *
 * このモジュールは状態を持たない純粋関数のみで構成する。
 * 入力（出力バッファ・最終出力からの経過時間・終了フラグ）に対して
 * 出力（状態文字列）が一意に決まるので、Electron も pty も無しでテストできる。
 */

/** @type {Record<string, import("../types/panedeck").SessionStatus>} */
const STATUS = {
  RUNNING: "running", // 出力が流れている（処理中）
  WAITING: "waiting", // ユーザーの入力を待っている（要操作）
  IDLE: "idle", // シェルプロンプトなどで待機中（何も走っていない）
  EXITED: "exited", // プロセス終了
};

/** この時間だけ出力が止まったら「静止した」とみなす (ms) */
const QUIET_MS = 400;

/** 状態判定で見る末尾の行数 */
const TAIL_LINES = 10;

// CSI (ESC [ ... 英字) と OSC (ESC ] ... BEL)
const ANSI_PATTERN = /\[[0-9;?]*[a-zA-Z]|\][^]*/g;

/** ユーザーの入力を待っていることを示すパターン */
const WAITING_PATTERNS = [
  /│\s*>/, // Claude Code の入力ボックス
  /❯/, // 選択肢プロンプト
  /\(y\/n\)/i, // 確認プロンプト
  /\[y\/n\]/i,
  /press enter/i,
];

/**
 * ANSI エスケープシーケンスを除去する。
 * @param {string|null|undefined} text
 * @returns {string}
 */
function stripAnsi(text) {
  if (text === null || text === undefined) return "";
  return String(text).replace(ANSI_PATTERN, "");
}

/**
 * 末尾の空行を無視して、最後の中身のある行を返す（行末の空白は落とす）。
 * @param {string} text
 * @returns {string}
 */
function lastNonEmptyLine(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/\s+$/, "");
    if (line !== "") return line;
  }
  return "";
}

/**
 * 出力の末尾から状態を判定する。
 *
 * 判定の優先順位:
 *   1. 終了している            → exited
 *   2. 直近に出力が動いている  → running
 *   3. 入力待ちパターンに一致  → waiting
 *   4. それ以外                → idle
 *
 * @param {object} params
 * @param {string} [params.tail] 出力バッファの末尾
 * @param {number} params.msSinceLastOutput 最後の出力からの経過時間 (ms)
 * @param {boolean} [params.exited] プロセスが終了したか
 * @param {number} [params.quietMs] 静止とみなす閾値 (ms)
 * @param {RegExp[]} [params.waitingPatterns] 入力待ちの判定パターン。
 *   エージェントごとに差し替えるための注入口。未指定なら既定を使う
 * @returns {import("../types/panedeck").SessionStatus}
 */
function detectStatus({
  tail,
  msSinceLastOutput,
  exited,
  quietMs = QUIET_MS,
  waitingPatterns,
}) {
  if (exited) return STATUS.EXITED;
  if (msSinceLastOutput < quietMs) return STATUS.RUNNING;

  // 空配列は「入力待ちを判定しない」という意思表示なので尊重する。
  // 配列でない値だけ既定へ落とす
  const patterns = Array.isArray(waitingPatterns) ? waitingPatterns : WAITING_PATTERNS;

  const clean = stripAnsi(tail);
  const recent = clean.split(/\r?\n/).slice(-TAIL_LINES).join("\n");

  if (patterns.some((pattern) => pattern.test(recent))) {
    return STATUS.WAITING;
  }

  return STATUS.IDLE;
}

module.exports = {
  STATUS,
  QUIET_MS,
  TAIL_LINES,
  WAITING_PATTERNS,
  stripAnsi,
  lastNonEmptyLine,
  detectStatus,
};
