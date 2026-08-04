/**
 * エージェントプロファイル。
 *
 * 「表示名 / 既定の起動コマンド / 入力待ちの判定パターン」を 1 組にしたもの。
 * PaneDeck は特定のエージェントに依存しない設計なので、状態判定も起動コマンドと
 * セットで差し替えられるようにここへ集約する。
 *
 * 状態を持たない定義とルックアップだけ。Electron にも pty にも依存しない。
 */

import type { AgentProfile, AgentProfileSummary } from "../types/panedeck";
import { WAITING_PATTERNS } from "./status-detector";

/**
 * エージェントを問わず現れる入力待ちの形。
 *
 * 確認プロンプトや選択肢はどの CLI でもほぼ同じ見た目になるので、
 * これを土台に各プロファイル固有のパターンを足す。
 */
export const COMMON_WAITING_PATTERNS: RegExp[] = [
  /❯/, // 選択肢プロンプト
  // 行頭の › も選択マーカー。実機の codex は ❯ ではなくこちらを使っていた。
  // 行頭に限るのは、文章中の › （File › Preferences のような表記）を
  // 選択肢と誤認しないため
  /^\s*›/m,
  /\(y\/n\)/i, // 確認プロンプト
  /\[y\/n\]/i,
  /press enter/i,
];

/**
 * 角丸ボックスの入力欄。
 *
 * Claude Code と Gemini CLI が同じ形を使う（どちらも実機で確認済み）。
 * 共通パターンに入れていないのは、確かめていないエージェントにまで
 * 広げないため。使うプロファイルで明示的に足す。
 */
const BOXED_PROMPT = /│\s*>/;

/**
 * 同梱するプロファイル。
 *
 * claude のパターンは status-detector の既定をそのまま使う。ここがずれると
 * 「エージェントを指定しなかったとき」と「claude を選んだとき」で判定が
 * 変わってしまうため、複製せず参照する。
 *
 * codex は共通パターンのみで足りる（入力欄・選択肢とも行頭の `›` で出る）。
 * gemini は Claude Code と同じ角丸ボックスを使うのでそれを足す。
 * どちらも実機のログから採取した。**確かめたものだけを足すこと。**
 * 当て推量の正規表現を入れると誤判定（実行中を入力待ちと見なす）が起きて
 * 主機能の信頼性が落ちる。
 */
export const AGENT_PROFILES: AgentProfile[] = [
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
    // 実機では `│ >   Type your message or @path/to/file` と出る
    waitingPatterns: [...COMMON_WAITING_PATTERNS, BOXED_PROMPT],
  },
  {
    id: "shell",
    name: "シェル",
    command: "",
    waitingPatterns: COMMON_WAITING_PATTERNS,
  },
];

/** 未指定・未知の id はこれにフォールバックする（改名前からの挙動を保つ） */
export const DEFAULT_AGENT_ID = "claude";

/**
 * レンダラへ渡せる形のプロファイル一覧。
 *
 * 正規表現は structured clone を通らず IPC に載せられないため、判定に使う
 * `waitingPatterns` は落として id / name / command だけを返す。判定は
 * メインプロセス側で行うので、レンダラが正規表現を持つ必要はない。
 */
export function listProfiles(): AgentProfileSummary[] {
  return AGENT_PROFILES.map(({ id, name, command }) => ({ id, name, command }));
}

/**
 * id からプロファイルを引く。未知・未指定なら既定を返す。
 *
 * 呼び出し側で存在確認をしなくて済むよう、必ずプロファイルを返す。
 */
export function resolveProfile(id?: unknown): AgentProfile {
  const found =
    typeof id === "string"
      ? AGENT_PROFILES.find((profile) => profile.id === id)
      : undefined;

  return found ?? AGENT_PROFILES.find((profile) => profile.id === DEFAULT_AGENT_ID)!;
}
