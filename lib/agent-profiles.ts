/**
 * エージェントプロファイル。
 *
 * 「表示名 / 既定の起動コマンド / 入力待ちの判定パターン」を 1 組にしたもの。
 * PaneDeck は特定のエージェントに依存しない設計なので、状態判定も起動コマンドと
 * セットで差し替えられるようにここへ集約する。
 *
 * 状態を持たない定義とルックアップだけ。Electron にも pty にも依存しない。
 */

import os from "os";
import path from "path";

import type { AgentProfile, AgentProfileSummary } from "../types/panedeck";
import { WAITING_PATTERNS } from "./status-detector";

/**
 * エージェントを問わず現れる入力待ちの形。
 *
 * 確認プロンプトや選択肢はどの CLI でもほぼ同じ見た目になるので、
 * これを土台に各プロファイル固有のパターンを足す。
 */
/**
 * どのプログラムでも同じ形になる「はい／いいえ」の問い。
 *
 * 記号ではなく**問いの文面**なので、プロンプトの見た目に左右されない。
 * シェルのように「何が動いているか分からない」場面でも使える。
 */
export const CONFIRMATION_PATTERNS: RegExp[] = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /press enter/i,
  // PowerShell の確認（-Confirm / ShouldProcess）。実機から採取:
  //   [Y] はい(Y)  [A] すべて続行(A)  [N] いいえ(N)  [L] すべて無視(L) …
  //   [Y] Yes  [A] Yes to All  [N] No  [L] No to All  [S] Suspend
  // **[Y] だけでは足りない**（文章中にも出うる）。同じ行に [N] まで
  // 揃ったときだけ問いとみなす
  /\[Y\][^\n]*\[N\]/i,
];

/**
 * Claude Code が会話の記録を置く場所（#33）。
 *
 * 作業ディレクトリを鍵にした入れ物の中に、会話ごとの 1 ファイルがある:
 *   `C:\app\panedeck` → `~/.claude/projects/C--app-panedeck/<uuid>.jsonl`
 *
 * **この符号化の作法はここに閉じる。** PaneDeck 本体に持たせると、
 * エージェントを増やすたびに本体を直すことになる（#33 の「依存しない」）。
 *
 * 区切りは `\` でも `/` でも同じ鍵になるように均す。設定は手で書かれるので
 * 両方の書き方が来る。
 */
function claudeRecordFile(cwd: string, sessionId: string): string {
  // **1 文字ずつ置き換える。** `+` を付けて続きをまとめると `C:\app` が
  // `C-app` になり、実機の `C--app-panedeck` と合わない（実際に踏んだ）
  const key = cwd.replace(/[:\\/]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", key, `${sessionId}.jsonl`);
}

export const COMMON_WAITING_PATTERNS: RegExp[] = [
  /❯/, // 選択肢プロンプト
  // 行頭の › も選択マーカー。実機の codex は ❯ ではなくこちらを使っていた。
  // 行頭に限るのは、文章中の › （File › Preferences のような表記）を
  // 選択肢と誤認しないため
  /^\s*›/m,
  ...CONFIRMATION_PATTERNS,
];

/**
 * 同梱するプロファイル。
 *
 * claude のパターンは status-detector の既定をそのまま使う。ここがずれると
 * 「エージェントを指定しなかったとき」と「claude を選んだとき」で判定が
 * 変わってしまうため、複製せず参照する。
 *
 * codex は共通パターンのみで足りる（入力欄・選択肢とも行頭の `›` で出る）。
 * 実機のログから採取した。**確かめたものだけを足すこと。** 当て推量の
 * 正規表現を入れると誤判定（実行中を入力待ちと見なす）が起きて主機能の
 * 信頼性が落ちる。
 *
 * **codex は #27 でも分割していない。** 実機（gpt-5.5）の入力欄は
 * `› Ask Codex to do anything`、選択肢は `› 1. Yes, continue` で、入力欄の
 * 目印になりうるのは空のときだけ出る案内文しかない。権限ダイアログは採取時に
 * 使用上限へ当たって到達できなかった。見分けられる確証が無いまま分割すると、
 * 知らないダイアログが ready（送ってよい）側へ落ちる。
 *
 * Gemini CLI は一度入れたが外した。角丸ボックス `│ >` を使い判定自体は
 * できていたものの、実機で日本語が入力できず（PaneDeck からは UTF-8 で
 * 正しく届いていることを確認済み）、CLI 自体が更新の対象から外れている
 * ように見えたため。id はもう解決できないが、`resolveProfile` が既定へ
 * 落とすので古い構成を読んでも壊れない。
 */
export const AGENT_PROFILES: AgentProfile[] = [
  {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    // 分割できないときの土台。カーソルは入力欄にもダイアログにも出るので、
    // これだけでは「送ってよいか」は決められない
    waitingPatterns: WAITING_PATTERNS,
    // 入力欄だと言える印。**カーソル `❯` は使えない** —— 実機 (v2.1.288) では
    // 確認ダイアログの選択カーソルにも同じ記号が出る。通常プロンプトの
    // フッターはダイアログの間だけ消えるので、これを印にする
    readyPatterns: [/(?:auto|manual|plan|accept edits) mode on/i, /\? for shortcuts/i],
    // 確認ダイアログの問い。**`Esc to cancel` は使ってはいけない** ——
    // 断った後も判定の窓に残り、asking に貼り付いてテキストが届かなくなる。
    // 問いの形はどのプログラムでも似るので、共通のものも併せて見る
    // （エージェントがシェルを呼べば、シェルの確認もペインに出る）
    askingPatterns: [/Do you want to/i, ...CONFIRMATION_PATTERNS],
    // 会話を指定して起動する呼び方（#33）。**初回と再開で別物** ——
    // 同じ `--session-id` を 2 回使うと `already in use` で落ちる（実測）
    sessionFlags: { start: "--session-id {id}", resume: "--resume {id}" },
    recordFile: claudeRecordFile,
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    waitingPatterns: COMMON_WAITING_PATTERNS,
  },
  {
    id: "shell",
    name: "シェル",
    command: "",
    // **記号は使わない（#30）。** `❯` と行頭 `›` はエージェントの選択肢から
    // 引き継いだもので、シェルで確かめたものではない。starship や oh-my-posh
    // ではどちらも**プロンプトそのもの**、つまり「待っていない」印になる。
    // 確かめていない印で「要操作」と言えば、ただ待っているだけのシェルが
    // 呼び出し続けることになる。
    //
    // 問いの文面だけを見る。これなら、どんなプロンプトを使っていても変わらない。
    waitingPatterns: CONFIRMATION_PATTERNS,
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
