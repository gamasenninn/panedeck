import fs from "fs";
import path from "path";

import type { Settings, TriggerConfig, ServiceConfig } from "../types/panedeck";

/**
 * アプリ設定の読み書き。
 *
 * Electron に依存しない。保存先のパスは呼び出し側から渡す前提で、
 * `app.getPath("userData")` の解決は main の仕事。こうしておくと
 * テストが実ユーザーの設定ファイルを触らずに済む。
 *
 * ワークスペース（どのディレクトリで開くか）とは別物として扱う。あちらは
 * 「構成を保存」を押したときだけ残るが、こちらは押さなくても次回に残ってほしい。
 */

export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;

/** 列数の上限。これ以上並べても 1 ペインが狭すぎて読めない */
export const COLUMNS_MAX = 6;

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 12,

  // 0 は「幅に合わせて自動で折り返す」。改名前からの見た目がこれ
  columns: 0,

  // 既定で有効にしても、保存された構成が無ければ何も起きない。
  // つまり初回起動の見え方は変わらない
  autoRestore: true,

  // ログの自動保存は既定で有効。以前は「際限なく溜まる」ため無効にしていたが、
  // 保持期間と合計サイズの上限が入ったのでその理由は消えた。
  // 既存の設定ファイルには値が明示的に書かれているため、この既定が効くのは
  // 新規インストールだけ
  autoLog: true,
  // 出力先。空なら呼び出し側が既定の場所（userData 配下）を決める
  logDir: "",
  // 後から読むためのログなので、既定では ANSI エスケープを落とす
  logStripAnsi: true,
  // 保持期間（日）。0 なら期間では消さない
  logRetentionDays: 30,
  // 合計サイズの上限 (MB)。0 ならサイズでは消さない
  logMaxTotalMB: 500,

  // ファイル監視のトリガー（#28）。既定は無し
  triggers: [],
  // どこまで届けたか。閉じている間に増えた行を次の起動で飛ばさないため
  triggerCursors: {},

  // 裏で走らせ続けるコマンド（#29）。既定は無し
  services: [],
};

/**
 * サービス 1 件を、使える形だけに整える。読めなければ null。
 *
 * `restart` は **never だけを受け付け、それ以外は always に寄せる**。
 * 打ち間違いを「起こし直さない」と解釈すると、落ちたまま黙って止まる。
 */
function normalizeService(raw: unknown): ServiceConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;

  const name = typeof source.name === "string" ? source.name.trim() : "";
  const command = typeof source.command === "string" ? source.command.trim() : "";
  if (name === "" || command === "") return null;

  return { name, command, restart: source.restart === "never" ? "never" : "always" };
}

/**
 * トリガー 1 件を、使える形だけに整える。読めなければ null。
 *
 * **読めないものは落として残りを活かす。** 設定は手で書かれる前提なので、
 * 1 つの打ち間違いで全部が死ぬのは割に合わない。
 */
function normalizeTrigger(raw: unknown): TriggerConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;

  const watch = typeof source.watch === "string" ? source.watch.trim() : "";
  const send = typeof source.send === "string" ? source.send : "";
  const pane = source.pane as Record<string, unknown> | undefined;
  const title =
    pane && typeof pane === "object" && typeof pane.title === "string"
      ? pane.title.trim()
      : "";

  if (watch === "" || send === "" || title === "") return null;

  // 余計な項目は持ち込まない
  return { watch, pane: { title }, send };
}

/**
 * 数値として読める値を範囲内へ収める。読めなければ既定を返す。
 *
 * 範囲外（0 や 999）は端に丸める。数値として解釈できている以上、既定へ戻すより
 * 端へ寄せるほうが入力の意図に近い。逆に "abc" のような解釈できない値を端に
 * 寄せるのは推測になるので、そちらは既定へ戻す。
 */
function clampNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const num =
    typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  if (!Number.isFinite(num)) return fallback;

  return Math.min(max, Math.max(min, Math.round(num)));
}

/**
 * 真偽値だけを受け入れる。"yes" や 1 を真とみなすと、書き間違いが
 * 意図した設定として通ってしまう。
 */
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * 設定を既知の項目だけの正しい形にする。
 *
 * 未知のフィールドは持ち込まない。設定ファイルは手で編集されうるので、
 * 読み込んだものをそのまま流さない。
 */
/** カーソルは 0 以上の数値だけを残す（負の値や文字列は読まなかったことにする） */
function normalizeCursors(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [file, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      out[file] = value;
    }
  }
  return out;
}

export function normalizeSettings(raw: unknown): Settings {
  const source: Record<string, unknown> =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  return {
    fontSize: clampNumber(
      source.fontSize,
      DEFAULT_SETTINGS.fontSize,
      FONT_SIZE_MIN,
      FONT_SIZE_MAX
    ),
    columns: clampNumber(source.columns, DEFAULT_SETTINGS.columns, 0, COLUMNS_MAX),
    autoRestore: bool(source.autoRestore, DEFAULT_SETTINGS.autoRestore),
    autoLog: bool(source.autoLog, DEFAULT_SETTINGS.autoLog),
    logStripAnsi: bool(source.logStripAnsi, DEFAULT_SETTINGS.logStripAnsi),
    logDir:
      typeof source.logDir === "string"
        ? source.logDir.trim()
        : DEFAULT_SETTINGS.logDir,
    // 上限は 0 が「無制限」。負の値は 0 に寄せる（消しすぎる方向へ倒さない）
    logRetentionDays: clampNumber(
      source.logRetentionDays,
      DEFAULT_SETTINGS.logRetentionDays,
      0,
      Number.MAX_SAFE_INTEGER
    ),
    // **同じファイルを見るものは最初の 1 つだけ。** どこまで届けたかは
    // 監視パスを鍵に保存するので（`triggerCursors`）、2 つ置くと互いに
    // 潰し合い、再起動のたびに片方の位置で両方が動く。README の
    // 「1 つの queue に配る人は 1 人」が、設定でも守られるようにする
    triggers: Array.isArray(source.triggers)
      ? source.triggers
          .map(normalizeTrigger)
          .filter((t): t is TriggerConfig => t !== null)
          .filter((t, i, all) => all.findIndex((other) => other.watch === t.watch) === i)
      : DEFAULT_SETTINGS.triggers,

    triggerCursors: normalizeCursors(source.triggerCursors),

    // 名前はログの宛先なので、重なったら最初のものだけ残す（取り違えを避ける）
    services: Array.isArray(source.services)
      ? source.services
          .map(normalizeService)
          .filter((s): s is ServiceConfig => s !== null)
          .filter(
            (s, i, all) => all.findIndex((other) => other.name === s.name) === i
          )
      : DEFAULT_SETTINGS.services,

    logMaxTotalMB: clampNumber(
      source.logMaxTotalMB,
      DEFAULT_SETTINGS.logMaxTotalMB,
      0,
      Number.MAX_SAFE_INTEGER
    ),
  };
}

/**
 * 設定ファイルを読む。
 *
 * 無い・壊れている・形が違う、のいずれでも例外を投げず既定を返す。
 * 設定ファイル 1 つでアプリが起動できなくなるのを避けるため。
 */
export function readSettings(filePath: string): Settings {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * 設定ファイルを書く（親ディレクトリが無ければ作る）。
 *
 * 読みと違い、書きの失敗は握り潰さない。保存できていないのに成功したように
 * 見えるほうが困るので、呼び出し側で通知する。
 *
 * @returns 実際に書いた（正規化後の）設定
 */
export function writeSettings(filePath: string, settings: Partial<Settings>): Settings {
  const normalized = normalizeSettings(settings);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

/**
 * 保存済みの設定に部分的な変更を重ねて書く。
 *
 * `writeSettings` は渡された形をそのまま正規化するので、片方の項目だけを渡すと
 * もう片方が既定へ戻ってしまう。UI は変更した項目だけを送るため、こちらを使う。
 */
export function updateSettings(filePath: string, patch: Partial<Settings>): Settings {
  return writeSettings(filePath, { ...readSettings(filePath), ...patch });
}
