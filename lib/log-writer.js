const fs = require("fs");
const path = require("path");

const { stripAnsi: stripAnsiText } = require("./status-detector");

/**
 * セッションの出力をファイルへ書き出す。
 *
 * Electron に依存しない。出力先ディレクトリと時計は注入され、書き込みの
 * タイミング（どれくらいの間隔で flush するか）は呼び出し側が決める。
 * pty の出力は高頻度なので、受け取るたびに fs を呼ばずバッファへ溜め、
 * まとめて追記する。
 */

/** ファイル名として使えない文字（Windows の禁止文字を含む） */
const UNSAFE_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;

/** ファイル名の上限（拡張子と時刻を含む） */
const MAX_NAME_LENGTH = 120;

/**
 * 時刻を `YYYYMMDD-HHmmss` にする（ローカル時刻）。
 * @param {number} time
 */
function timestamp(time) {
  const d = new Date(time);
  const pad = (n) => String(n).padStart(2, "0");

  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    "-",
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join("");
}

/**
 * ログファイル名を作る。
 *
 * どのセッションのいつの記録かが名前だけで分かるように、タイトルと起動時刻を
 * 含める。タイトルはユーザーが付けるので、そのままではファイル名に使えない
 * 文字が混ざりうる。
 *
 * @param {string} title
 * @param {number} time
 * @returns {string}
 */
function logFileName(title, time) {
  const stamp = timestamp(time);
  const suffix = `-${stamp}.log`;

  const safe = String(title ?? "")
    .replace(UNSAFE_CHARS, "_")
    .trim();
  const base = safe === "" ? "session" : safe;

  return `${base.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
}

class LogWriter {
  /**
   * @param {object} deps
   * @param {string} deps.dir 出力先ディレクトリ
   * @param {() => number} [deps.now] 現在時刻 (ms)
   * @param {boolean} [deps.stripAnsi] ANSI エスケープを除去して書くか
   */
  constructor({ dir, now = () => Date.now(), stripAnsi = true }) {
    this.dir = dir;
    this.now = now;
    this.stripAnsi = stripAnsi;

    /** @type {Map<string, string>} セッション id → 出力先パス */
    this.paths = new Map();
    /** @type {Map<string, string>} セッション id → 未書き込みの出力 */
    this.buffers = new Map();
    /** @type {Set<string>} 書き込みに失敗して諦めたセッション */
    this.failed = new Set();
  }

  /**
   * セッションの記録を開始し、出力先パスを返す。
   *
   * ファイルはまだ作らない。出力が無いまま閉じたセッションで空ファイルが
   * 散らかるのを避ける。
   *
   * @param {string} id
   * @param {string} title
   * @returns {string}
   */
  open(id, title) {
    this.paths.set(id, this._uniquePath(logFileName(title, this.now())));
    this.buffers.set(id, "");
    this.failed.delete(id);
    return this.paths.get(id);
  }

  /**
   * 出力を溜める。開いていない・諦めたセッションのぶんは捨てる。
   * @param {string} id
   * @param {string} data
   */
  append(id, data) {
    if (!this.paths.has(id) || this.failed.has(id)) return;

    const text = this.stripAnsi ? stripAnsiText(data) : data;
    this.buffers.set(id, this.buffers.get(id) + text);
  }

  /**
   * 溜まっている出力をまとめて追記する。
   *
   * 例外は投げない。ログが書けないことでセッションの操作を止めるべきではない。
   * 失敗したセッションは以降の書き込みをやめる。出力のたびに失敗し続けると
   * 通知が止まらなくなるため。
   *
   * @returns {Array<{id: string, filePath: string, error: string}>} 失敗した分
   */
  flush() {
    const failures = [];

    for (const [id, buffered] of this.buffers) {
      if (buffered === "" || this.failed.has(id)) continue;

      const filePath = this.paths.get(id);
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.appendFileSync(filePath, buffered, "utf8");
        this.buffers.set(id, "");
      } catch (err) {
        this.failed.add(id);
        this.buffers.set(id, "");
        failures.push({ id, filePath, error: err.message });
      }
    }

    return failures;
  }

  /**
   * 1 セッションの記録を終える（書き残しを吐き出してから忘れる）。
   * @param {string} id
   * @returns {Array<{id: string, filePath: string, error: string}>}
   */
  close(id) {
    const failures = this.flush().filter((failure) => failure.id === id);

    this.paths.delete(id);
    this.buffers.delete(id);
    this.failed.delete(id);

    return failures;
  }

  /** 全セッションの記録を終える。 */
  closeAll() {
    const failures = this.flush();

    this.paths.clear();
    this.buffers.clear();
    this.failed.clear();

    return failures;
  }

  /**
   * 既に同名のファイルがあれば連番で避ける。
   *
   * 同じ秒に同じタイトルのセッションを開くと衝突し、片方の記録が
   * もう片方に混ざってしまう。
   */
  _uniquePath(fileName) {
    const used = new Set(this.paths.values());
    const ext = path.extname(fileName);
    const base = fileName.slice(0, -ext.length);

    let candidate = path.join(this.dir, fileName);
    let n = 1;
    while (used.has(candidate) || fs.existsSync(candidate)) {
      n += 1;
      candidate = path.join(this.dir, `${base}-${n}${ext}`);
    }

    return candidate;
  }
}

module.exports = { LogWriter, logFileName };
