import type {
  CreateSessionOptions,
  LiveSession,
  Pty,
  PtyFactoryOptions,
  Session,
  BroadcastOptions,
} from "../types/panedeck";
import { detectStatus, STATUS } from "./status-detector";
import { normalizeCommand } from "./command";
import { resolveProfile } from "./agent-profiles";

export { STATUS };

/** ログとして保持する最大文字数（超えたら先頭から捨てる） */
export const DEFAULT_MAX_LOG_BYTES = 500000;

/** 状態判定に渡す末尾の文字数 */
const TAIL_CHARS = 2000;

/**
 * cwd の末尾セグメントを既定タイトルにする（Windows / POSIX どちらの区切りも扱う）。
 */
export function defaultTitle(cwd?: string): string {
  const segments = String(cwd ?? "")
    .split(/[\\/]/)
    .filter(Boolean);
  return segments[segments.length - 1] ?? "session";
}

export interface SessionManagerDeps {
  /** pty を生成する関数 */
  ptyFactory: (options: PtyFactoryOptions) => Pty;
  /** 現在時刻 (ms) */
  now?: () => number;
  /** ログ保持量の上限 */
  maxLogBytes?: number;
}

/**
 * 複数の pty セッションを束ねるレジストリ。
 *
 * Electron にも node-pty にも直接依存しない。pty の生成は `ptyFactory` として
 * 注入されるので、テストではフェイクを渡して実プロセス無しに検証できる。
 */
export class SessionManager {
  ptyFactory: (options: PtyFactoryOptions) => Pty;
  now: () => number;
  maxLogBytes: number;

  sessions = new Map<string, LiveSession>();
  nextId = 1;

  dataHandlers: Array<(id: string, data: string) => void> = [];
  exitHandlers: Array<(id: string, exitCode: number) => void> = [];

  constructor({
    ptyFactory,
    now = () => Date.now(),
    maxLogBytes = DEFAULT_MAX_LOG_BYTES,
  }: SessionManagerDeps) {
    this.ptyFactory = ptyFactory;
    this.now = now;
    this.maxLogBytes = maxLogBytes;
  }

  /** セッションを生成する。 */
  create({
    cwd,
    shell,
    args = [],
    title,
    cols = 80,
    rows = 24,
    env,
    initialCommand,
    agent,
  }: CreateSessionOptions = {}): Session {
    const id = `s${this.nextId++}`;
    const pty = this.ptyFactory({ shell, args, cwd, cols, rows, env });
    const command = normalizeCommand(initialCommand);
    // 未知の id はここで既定へ寄せる。以降は必ず実在するプロファイルを指す
    const profile = resolveProfile(agent);

    const session: LiveSession = {
      id,
      title: title || defaultTitle(cwd),
      cwd,
      shell,
      args,
      cols,
      rows,
      initialCommand: command,
      profile,
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

    // ハンドラ登録後に流し込む。これで起動コマンド自身のエコーもログに載る。
    if (command) pty.write(`${command}\r`);

    return this._snapshot(session);
  }

  get(id: string): Session | null {
    const session = this.sessions.get(id);
    return session ? this._snapshot(session) : null;
  }

  /** 生成順（並べ替え後はその順）のスナップショット一覧 */
  list(): Session[] {
    return [...this.sessions.values()].map((s) => this._snapshot(s));
  }

  /** 1 セッションに書き込む。 */
  write(id: string, data: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.exited) return false;
    session.pty.write(data);
    return true;
  }

  /**
   * 複数セッションへまとめて書き込む。
   *
   * `onlyStatus` を渡すと、その状態のセッションだけに絞る。状態は書き込み直前に
   * 算出するので、レンダラ側が持つ（ポーリング遅れのある）状態ではなく
   * 送信時点の状態で判定される。
   *
   * @param ids 未指定なら全セッション
   * @returns 実際に書き込めた数
   */
  broadcast(data: string, ids?: string[] | null, options?: BroadcastOptions): number {
    const { onlyStatus } = options ?? {};
    const targets = ids ?? [...this.sessions.keys()];
    const filtered = onlyStatus
      ? targets.filter((id) => this.get(id)?.status === onlyStatus)
      : targets;

    return filtered.reduce((count, id) => count + (this.write(id, data) ? 1 : 0), 0);
  }

  /**
   * セッションの並び順を差し替える。
   *
   * 並び順の持ち主をここに一本化する。レンダラは 300ms 間隔で `list()` を
   * 突き合わせているので、順序をレンダラ側に持たせるとポーリングのたびに
   * 並びが戻る事故が起きうる。一覧が既に正しい順で返れば、その事故は原理的に
   * 起きない。
   *
   * セッションの中身（pty・ログ）はそのまま。並べ替えで再接続は起きない。
   *
   * @param orderedIds 並べたい順の id。
   *   含まれない既存セッションは、相対順を保ったまま末尾に残る
   * @returns 並べ替え後の id 一覧
   */
  reorder(orderedIds: string[]): string[] {
    const requested = Array.isArray(orderedIds) ? orderedIds : [];

    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const id of requested) {
      if (seen.has(id) || !this.sessions.has(id)) continue;
      seen.add(id);
      ordered.push(id);
    }

    // 指定されなかったぶんは元の順のまま後ろへ。並べ替え中に増えた
    // セッションが消えないようにする
    for (const id of this.sessions.keys()) {
      if (!seen.has(id)) ordered.push(id);
    }

    const entries = ordered.map((id) => [id, this.sessions.get(id)!] as const);
    this.sessions.clear();
    for (const [id, session] of entries) this.sessions.set(id, session);

    return ordered;
  }

  /**
   * pty のサイズを変える。
   *
   * 終了済みのセッションは対象外。node-pty は終了した pty をリサイズすると
   * 例外を投げ、レンダラは文字サイズ・列数・ウィンドウの変化のたびに全ペインへ
   * resize を投げるので、終了したペインが 1 つ残っているだけでメインプロセスの
   * 未処理例外になる。書き込み（write）と同じ扱いにそろえる。
   */
  resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (!session || session.exited) return false;
    session.cols = cols;
    session.rows = rows;
    session.pty.resize(cols, rows);
    return true;
  }

  close(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.pty.kill();
    this.sessions.delete(id);
    return true;
  }

  /** @returns 閉じた数 */
  closeAll(): number {
    const ids = [...this.sessions.keys()];
    return ids.reduce((count, id) => count + (this.close(id) ? 1 : 0), 0);
  }

  /** 蓄積された出力（存在しなければ空文字列） */
  getLog(id: string): string {
    const session = this.sessions.get(id);
    return session ? session.log : "";
  }

  /** 出力受信時に (id, data) で呼ばれるコールバックを登録する */
  onData(cb: (id: string, data: string) => void): void {
    this.dataHandlers.push(cb);
  }

  /** プロセス終了時に (id, exitCode) で呼ばれるコールバックを登録する */
  onExit(cb: (id: string, exitCode: number) => void): void {
    this.exitHandlers.push(cb);
  }

  private _appendLog(log: string, data: string): string {
    const next = log + data;
    return next.length > this.maxLogBytes ? next.slice(-this.maxLogBytes) : next;
  }

  /** pty 本体を除いた、IPC で送れる形のスナップショットを作る */
  private _snapshot(session: LiveSession): Session {
    return {
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      shell: session.shell,
      args: session.args,
      cols: session.cols,
      rows: session.rows,
      initialCommand: session.initialCommand,
      agent: session.profile.id,
      exited: session.exited,
      exitCode: session.exitCode,
      status: detectStatus({
        tail: session.log.slice(-TAIL_CHARS),
        msSinceLastOutput: this.now() - session.lastOutputAt,
        exited: session.exited,
        waitingPatterns: session.profile.waitingPatterns,
      }),
    };
  }
}
