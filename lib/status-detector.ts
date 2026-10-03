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
  WAITING: "waiting", // 入力待ち（ready と asking を見分けられないとき）
  READY: "ready", // 入力欄で次の指示を待っている（打った文字は指示になる）
  ASKING: "asking", // 質問で止まっている（打鍵がそのまま回答になる）
  IDLE: "idle", // シェルプロンプトなどで待機中（何も走っていない）
  EXITED: "exited", // プロセス終了
} as const satisfies Record<string, SessionStatus>;

/** この時間だけ出力が止まったら「静止した」とみなす (ms) */
export const QUIET_MS = 400;

/** 状態判定で見る末尾の行数 */
export const TAIL_LINES = 10;

/**
 * CSI (ESC [ ... 終端) と OSC (ESC ] ... BEL または ESC \)
 *
 * CSI は仕様どおり「パラメータ (0x30-0x3F) → 中間バイト (0x20-0x2F) → 終端
 * (0x40-0x7E)」で書く。以前はパラメータを数字と `?` だけ、終端を英字だけと
 * していて、カーソル形状の指定 `ESC [ 0 SP q` のように中間バイトを挟むものを
 * 取り切れず、本文に残っていた（実機の codex が出していた）。
 *
 * **OSC は必ず終端まででとどめる。** 以前は `\x1b\][^]*` と書いていて、
 * OSC 以降を末尾まで全部消していた。シェルは起動のたびにタイトルを設定する
 * （PowerShell も出す）ので、判定が見る末尾に OSC が 1 つでもあると、そこから
 * 後ろが丸ごと消えて「出力が空」になり、入力待ちを検出できなくなっていた。
 * 実際に codex のログでは 4405 文字が 46 文字まで削られていた。
 *
 * 最後の `\x1b\\` は宙に浮いた ST（文字列終端）を拾うため。判定は末尾 2000 文字
 * だけを見るので、その境界が OSC の途中に落ちると開始が窓の外へ出て、終端だけが
 * 本文に残る。ST は常に終端であって中身ではないので、単独で消してよい。
 *
 * ESC は `\x1b` と書く。生の制御文字を正規表現へ直接埋めると、ソース上で
 * 目に見えないまま消えうる（実際、移行時に落ちて `[Y/n]` を ANSI と誤って
 * 削っていた）。
 */
const ANSI_PATTERN =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\\/g;

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
  /** 入力欄で待っていると分かる印（#27） */
  readyPatterns?: RegExp[];
  /**
   * 質問で止まっていると分かる印（#27）。
   *
   * **これが与えられたときだけ分割が働く。** asking を見分けられないまま
   * ready と言い切ると、確認ダイアログが「送ってよい」側に回るため。
   */
  askingPatterns?: RegExp[];
}

/**
 * 出力の末尾から状態を判定する。
 *
 * 判定の優先順位:
 *   1. 終了している            → exited
 *   2. 直近に出力が動いている  → running
 *   3. 質問の印に一致          → asking   （分割があるとき）
 *   4. 入力欄の印に一致        → ready    （分割があるとき）
 *   5. 入力待ちパターンに一致  → waiting  （分割の有無を問わず）
 *   6. それ以外                → idle
 *
 * 分割があるときの waiting は「何かが待っているが、指示待ちか確認待ちか
 * 見分けられない」を意味する。カーソルは入力欄にも選択式ダイアログにも出る
 * ので、**入力欄だと言える印が無ければ ready とは言わない。** 知らない
 * ダイアログが将来増えても、壊れ方が送らない側に倒れる。
 *
 * **asking は ready より先に見る。** 画面の書き換え途中やダイアログの上に
 * 入力欄の枠が残っているときは両方が見えうるので、迷ったら送らない側へ倒す。
 */
export function detectStatus({
  tail,
  msSinceLastOutput,
  exited,
  quietMs = QUIET_MS,
  waitingPatterns,
  readyPatterns,
  askingPatterns,
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

  const matches = (candidates?: RegExp[]) =>
    Array.isArray(candidates) && candidates.some((pattern) => pattern.test(recent));

  // 分割は asking の印があるときだけ。見分けられないまま ready と言い切ると、
  // 確認ダイアログが「送ってよい」側に回る
  if (Array.isArray(askingPatterns)) {
    if (matches(askingPatterns)) return STATUS.ASKING;
    if (matches(readyPatterns)) return STATUS.READY;
    // どちらとも言えないが何かが待っている、という段。知らないダイアログは
    // ここへ落ちる（ready 側へ落とすと「送ってよい」と誤って言うことになる）
    if (matches(waitingPatterns)) return STATUS.WAITING;
    return STATUS.IDLE;
  }

  if (patterns.some((pattern) => pattern.test(recent))) {
    return STATUS.WAITING;
  }

  return STATUS.IDLE;
}
