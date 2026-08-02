const { detectStatus, STATUS } = require("./status-detector");

/** ログとして保持する最大文字数（超えたら先頭から捨てる） */
const DEFAULT_MAX_LOG_BYTES = 500000;

/** 状態判定に渡す末尾の文字数 */
const TAIL_CHARS = 2000;

/**
 * cwd の末尾セグメントを既定タイトルにする（Windows / POSIX どちらの区切りも扱う）。
 */
function defaultTitle(cwd) {
  const segments = String(cwd ?? "")
    .split(/[\\/]/)
    .filter(Boolean);
  return segments[segments.length - 1] ?? "session";
}

/**
 * 複数の pty セッションを束ねるレジストリ。
 *
 * Electron にも node-pty にも直接依存しない。pty の生成は `ptyFactory` として
 * 注入されるので、テストではフェイクを渡して実プロセス無しに検証できる。
 */
class SessionManager {
  /**
   * @param {object} deps
   * @param {(options: object) => object} deps.ptyFactory pty を生成する関数
   * @param {() => number} [deps.now] 現在時刻 (ms)
   * @param {number} [deps.maxLogBytes] ログ保持量の上限
   */
  constructor({ ptyFactory, now = () => Date.now(), maxLogBytes = DEFAULT_MAX_LOG_BYTES }) {
    this.ptyFactory = ptyFactory;
    this.now = now;
    this.maxLogBytes = maxLogBytes;

    /** @type {Map<string, object>} */
    this.sessions = new Map();
    this.nextId = 1;

    this.dataHandlers = [];
    this.exitHandlers = [];
  }

  /**
   * セッションを生成する。
   * @returns {object} スナップショット
   */
  create({ cwd, shell, args = [], title, cols = 80, rows = 24, env } = {}) {
    const id = `s${this.nextId++}`;
    const pty = this.ptyFactory({ shell, args, cwd, cols, rows, env });

    const session = {
      id,
      title: title || defaultTitle(cwd),
      cwd,
      shell,
      args,
      cols,
      rows,
      pty,
      log: "",
      lastOutputAt: this.now(),
      exited: false,
      exitCode: null,
    };
    this.sessions.set(id, session);

    pty.onData((data) => {
      session.log = this._appendLog(session.log, data);
      session.lastOutputAt = this.now();
      this.dataHandlers.forEach((cb) => cb(id, data));
    });

    pty.onExit(({ exitCode }) => {
      session.exited = true;
      session.exitCode = exitCode;
      this.exitHandlers.forEach((cb) => cb(id, exitCode));
    });

    return this._snapshot(session);
  }

  /** @returns {object|null} */
  get(id) {
    const session = this.sessions.get(id);
    return session ? this._snapshot(session) : null;
  }

  /** @returns {object[]} 生成順のスナップショット一覧 */
  list() {
    return [...this.sessions.values()].map((s) => this._snapshot(s));
  }

  /**
   * 1 セッションに書き込む。
   * @returns {boolean} 書き込めたか
   */
  write(id, data) {
    const session = this.sessions.get(id);
    if (!session || session.exited) return false;
    session.pty.write(data);
    return true;
  }

  /**
   * 複数セッションへまとめて書き込む。
   * @param {string} data
   * @param {string[]} [ids] 未指定なら全セッション
   * @returns {number} 実際に書き込めた数
   */
  broadcast(data, ids) {
    const targets = ids ?? [...this.sessions.keys()];
    return targets.reduce((count, id) => count + (this.write(id, data) ? 1 : 0), 0);
  }

  /** @returns {boolean} */
  resize(id, cols, rows) {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.cols = cols;
    session.rows = rows;
    session.pty.resize(cols, rows);
    return true;
  }

  /** @returns {boolean} */
  close(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.pty.kill();
    this.sessions.delete(id);
    return true;
  }

  /** @returns {number} 閉じた数 */
  closeAll() {
    const ids = [...this.sessions.keys()];
    return ids.reduce((count, id) => count + (this.close(id) ? 1 : 0), 0);
  }

  /** @returns {string} 蓄積された出力（存在しなければ空文字列） */
  getLog(id) {
    const session = this.sessions.get(id);
    return session ? session.log : "";
  }

  /** 出力受信時に (id, data) で呼ばれるコールバックを登録する */
  onData(cb) {
    this.dataHandlers.push(cb);
  }

  /** プロセス終了時に (id, exitCode) で呼ばれるコールバックを登録する */
  onExit(cb) {
    this.exitHandlers.push(cb);
  }

  _appendLog(log, data) {
    const next = log + data;
    return next.length > this.maxLogBytes ? next.slice(-this.maxLogBytes) : next;
  }

  /** pty 本体を除いた、IPC で送れる形のスナップショットを作る */
  _snapshot(session) {
    return {
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      shell: session.shell,
      args: session.args,
      cols: session.cols,
      rows: session.rows,
      exited: session.exited,
      exitCode: session.exitCode,
      status: detectStatus({
        tail: session.log.slice(-TAIL_CHARS),
        msSinceLastOutput: this.now() - session.lastOutputAt,
        exited: session.exited,
      }),
    };
  }
}

module.exports = { SessionManager, STATUS, defaultTitle, DEFAULT_MAX_LOG_BYTES };
