/**
 * pty の出力からセッションの状態を判定する。
 *
 * このモジュールは状態を持たない純粋関数のみで構成する。
 * 入力（出力バッファ・最終出力からの経過時間・終了フラグ）に対して
 * 出力（状態文字列）が一意に決まるので、Electron も pty も無しでテストできる。
 */

import type { SessionStatus } from "../types/panedeck";

export const STATUS = {
  RUNNING: "running", // 出力が流れている（処理中）
  WAITING: "waiting", // ユーザーの入力を待っている（要操作）
  IDLE: "idle", // シェルプロンプトなどで待機中（何も走っていない）
  EXITED: "exited", // プロセス終了
} as const satisfies Record<string, SessionStatus>;

/** この時間だけ出力が止まったら「静止した」とみなす (ms) */
export const QUIET_MS = 400;

/** 状態判定で見る末尾の行数 */
export const TAIL_LINES = 10;

/**
 * CSI (ESC [ ... 英字) と OSC (ESC ] ... BEL または ESC \)
 *
 * **OSC は必ず終端まででとどめる。** 以前は `\x1b\][^]*` と書いていて、
 * OSC 以降を末尾まで全部消していた。シェルは起動のたびにタイトルを設定する
 * （PowerShell も出す）ので、判定が見る末尾に OSC が 1 つでもあると、そこから
 * 後ろが丸ごと消えて「出力が空」になり、入力待ちを検出できなくなっていた。
 * 実際に codex のログでは 4405 文字が 46 文字まで削られていた。
 *
 * ESC は `\x1b` と書く。生の制御文字を正規表現へ直接埋めると、ソース上で
 * 目に見えないまま消えうる（実際、移行時に落ちて `[Y/n]` を ANSI と誤って
 * 削っていた）。
 */
const ANSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;

/** ユーザーの入力を待っていることを示すパターン */
export const WAITING_PATTERNS: RegExp[] = [
  /│\s*>/, // Claude Code の入力ボックス
  /❯/, // 選択肢プロンプト
  /\(y\/n\)/i, // 確認プロンプト
  /\[y\/n\]/i,
  /press enter/i,
];

/** ANSI エスケープシーケンスを除去する。 */
export function stripAnsi(text: string | null | undefined): string {
  if (text === null || text === undefined) return "";
  return String(text).replace(ANSI_PATTERN, "");
}

/** 末尾の空行を無視して、最後の中身のある行を返す（行末の空白は落とす）。 */
export function lastNonEmptyLine(text: string): string {
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/\s+$/, "");
    if (line !== "") return line;
  }
  return "";
}

export interface DetectStatusParams {
  /** 出力バッファの末尾 */
  tail?: string;
  /** 最後の出力からの経過時間 (ms) */
  msSinceLastOutput: number;
  /** プロセスが終了したか */
  exited?: boolean;
  /** 静止とみなす閾値 (ms) */
  quietMs?: number;
  /**
   * 入力待ちの判定パターン。エージェントごとに差し替えるための注入口。
   * 未指定なら既定を使う
   */
  waitingPatterns?: RegExp[];
}

/**
 * 出力の末尾から状態を判定する。
 *
 * 判定の優先順位:
 *   1. 終了している            → exited
 *   2. 直近に出力が動いている  → running
 *   3. 入力待ちパターンに一致  → waiting
 *   4. それ以外                → idle
 */
export function detectStatus({
  tail,
  msSinceLastOutput,
  exited,
  quietMs = QUIET_MS,
  waitingPatterns,
}: DetectStatusParams): SessionStatus {
  if (exited) return STATUS.EXITED;
  if (msSinceLastOutput < quietMs) return STATUS.RUNNING;

  // 空配列は「入力待ちを判定しない」という意思表示なので尊重する。
  // 配列でない値だけ既定へ落とす
  const patterns = Array.isArray(waitingPatterns) ? waitingPatterns : WAITING_PATTERNS;

  // 空行は数に入れない。全画面 TUI は画面下を空行で埋めるので、そのまま
  // 行数で切ると中身が窓の外へ押し出される（codex のログでは 91 行のうち
  // 中身は 59 行目までで、末尾 10 行はすべて空行だった）
  const clean = stripAnsi(tail);
  const recent = clean
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-TAIL_LINES)
    .join("\n");

  if (patterns.some((pattern) => pattern.test(recent))) {
    return STATUS.WAITING;
  }

  return STATUS.IDLE;
}
