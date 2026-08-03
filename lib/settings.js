const fs = require("fs");
const path = require("path");

/**
 * アプリ設定の読み書き。
 *
 * Electron に依存しない。保存先のパスは呼び出し側から渡す前提で、
 * `app.getPath("userData")` の解決は main.js の仕事。こうしておくと
 * テストが実ユーザーの設定ファイルを触らずに済む。
 *
 * ワークスペース（どのディレクトリで開くか）とは別物として扱う。あちらは
 * 「構成を保存」を押したときだけ残るが、こちらは押さなくても次回に残ってほしい。
 */

/** @import * as Types from "../types/panedeck" */

const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 32;

/** @type {Types.Settings} */
const DEFAULT_SETTINGS = {
  fontSize: 12,
  // 既定で有効にしても、保存された構成が無ければ何も起きない。
  // つまり初回起動の見え方は変わらない
  autoRestore: true,

  // ログの自動保存は既定で無効。保持期間・上限の仕組みがまだ無く、
  // 有効なままだと際限なく溜まる。ディスクへ黙って書き続けるより選ばせる
  autoLog: false,
  // 出力先。空なら呼び出し側が既定の場所（userData 配下）を決める
  logDir: "",
  // 後から読むためのログなので、既定では ANSI エスケープを落とす
  logStripAnsi: true,
};

/**
 * 数値として読める値を範囲内へ収める。読めなければ既定を返す。
 *
 * 範囲外（0 や 999）は端に丸める。数値として解釈できている以上、既定へ戻すより
 * 端へ寄せるほうが入力の意図に近い。逆に "abc" のような解釈できない値を端に
 * 寄せるのは推測になるので、そちらは既定へ戻す。
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function clampNumber(value, fallback) {
  const num = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  if (!Number.isFinite(num)) return fallback;

  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(num)));
}

/**
 * 真偽値だけを受け入れる。"yes" や 1 を真とみなすと、書き間違いが
 * 意図した設定として通ってしまう。
 *
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * 設定を既知の項目だけの正しい形にする。
 *
 * 未知のフィールドは持ち込まない。設定ファイルは手で編集されうるので、
 * 読み込んだものをそのまま流さない。
 *
 * @param {unknown} raw
 * @returns {Types.Settings}
 */
function normalizeSettings(raw) {
  const source = raw && typeof raw === "object" ? /** @type {any} */ (raw) : {};

  return {
    fontSize: clampNumber(source.fontSize, DEFAULT_SETTINGS.fontSize),
    // 真偽値以外は解釈しない。"yes" や 1 を真とみなすと、書き間違いが
    // 意図した設定として通ってしまう
    autoRestore: bool(source.autoRestore, DEFAULT_SETTINGS.autoRestore),
    autoLog: bool(source.autoLog, DEFAULT_SETTINGS.autoLog),
    logStripAnsi: bool(source.logStripAnsi, DEFAULT_SETTINGS.logStripAnsi),
    logDir:
      typeof source.logDir === "string" ? source.logDir.trim() : DEFAULT_SETTINGS.logDir,
  };
}

/**
 * 設定ファイルを読む。
 *
 * 無い・壊れている・形が違う、のいずれでも例外を投げず既定を返す。
 * 設定ファイル 1 つでアプリが起動できなくなるのを避けるため。
 *
 * @param {string} filePath
 * @returns {Types.Settings}
 */
function readSettings(filePath) {
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
 * @param {string} filePath
 * @param {Partial<Types.Settings>} settings
 * @returns {Types.Settings} 実際に書いた（正規化後の）設定
 */
function writeSettings(filePath, settings) {
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
 *
 * @param {string} filePath
 * @param {Partial<Types.Settings>} patch
 * @returns {Types.Settings} 実際に書いた（正規化後の）設定
 */
function updateSettings(filePath, patch) {
  return writeSettings(filePath, { ...readSettings(filePath), ...patch });
}

module.exports = {
  DEFAULT_SETTINGS,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  normalizeSettings,
  readSettings,
  writeSettings,
  updateSettings,
};
