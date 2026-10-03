import type { SessionStatus } from "../types/panedeck";

/**
 * レンダラ側の定数。
 *
 * ESM 化して最初に切り出したもの。renderer.ts から
 * `import { ... } from "./renderer/constants.js"` で読む。
 * バンドラを挟まないので、**相対 import には拡張子 .js が要る**
 * （ブラウザは解決を補完しない）。
 */

/**
 * バッジの文言。
 *
 * `waiting` は ready と asking を見分けられないときの従来表示。見分けられる
 * プロファイルでは、**打った文字が指示になる**（指示待ち）のか、
 * **打鍵がそのまま回答になる**（確認待ち）のかが一目で分かるようにする（#27）。
 */
export const STATUS_LABELS: Record<SessionStatus, string> = {
  running: "実行中",
  waiting: "入力待ち",
  ready: "指示待ち",
  asking: "確認待ち",
  idle: "待機",
  exited: "終了",
};

/** 「入力待ちのみ」で絞るときの状態 */
export const WAITING: SessionStatus = "waiting";

/** 入力欄で待っている。打った文字は指示になる（#27） */
export const READY: SessionStatus = "ready";

/** 質問で止まっている。打鍵がそのまま回答になる（#27） */
export const ASKING: SessionStatus = "asking";

/** 特殊キーのエスケープシーケンス */
export const KEY_SEQUENCES: Record<string, string> = {
  enter: "\r",
  esc: "\x1b",
  "ctrl-c": "\x03",
  up: "\x1b[A",
  down: "\x1b[B",
};
