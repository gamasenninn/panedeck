import type {
  CreateSessionOptions,
  LiveSession,
  Pty,
  PtyFactoryOptions,
  Session,
  BroadcastOptions,
} from "../types/panedeck";
import { detectStatus, STATUS } from "./status-detector";
import { randomUUID } from "crypto";

import { normalizeCommand } from "./command";
import { sessionCommand } from "./session-command";
import { resolveProfile } from "./agent-profiles";

export { STATUS };

/** ログとして保持する最大文字数（超えたら先頭から捨てる） */
export const DEFAULT_MAX_LOG_BYTES = 500000;

/** 題に混ぜてはいけない文字。改行が入ると表示も宛先の一致判定も壊れる */
const CONTROL_CHARS = /[\x00-\x1f\x7f]+/g;

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

/**
 * 判定のために「いま画面に見えているもの」を保つ入れ物（#31）。
 *
 * pty のバイト列は塗られたものすべての記録で、全画面 TUI は変えた領域だけを
 * 塗り直す。記録の末尾は「最後に塗られた場所」であって画面ではない。
 * 画面を組み立てるのは端末エミュレータの仕事なので、ここでは**形だけ**を
 * 決めて実体は外から注入する。lib/ は端末エミュレータを知らないままでいる。
 */
export interface Screen {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** いま見えている内容（上から下まで） */
  read(): string;
  dispose(): void;
}

export interface SessionManagerDeps {
  /** pty を生成する関数 */
  ptyFactory: (options: PtyFactoryOptions) => Pty;
  /**
   * 画面を生成する関数。渡さなければ記録の末尾で判定する（従来どおり）。
   *
   * 既定を持たせないのは、既定にすると lib/ が端末エミュレータに依存するため。
   */
  screenFactory?: (options: { cols: number; rows: number }) => Screen;
  /** 現在時刻 (ms) */
  now?: () => number;
  /** ログ保持量の上限 */
  maxLogBytes?: number;
  /**
   * pid のプロセスがまだ居るかを返す。
   *
   * 既定はシグナル 0 の送信。存在しないプロセスなら例外になるので、
   * 何も起こさずに生死だけを確かめられる。
   */
  isProcessAlive?: (pid: number) => boolean;
  /**
   * 会話の id を作る（#33）。テストから差し替えられるように注入する。
   *
   * 既定は `crypto.randomUUID()`。claude は有効な UUID を要求する。
   */
  newSessionId?: () => string;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  isProcessAlive: (pid: number) => boolean;
  private newSessionId: () => string;
  screenFactory: ((options: { cols: number; rows: number }) => Screen) | null;

  /** セッション id → 画面。screenFactory を渡さなければ空のまま */
  screens = new Map<string, Screen>();

  sessions = new Map<string, LiveSession>();
  nextId = 1;

  dataHandlers: Array<(id: string, data: string) => void> = [];
  exitHandlers: Array<(id: string, exitCode: number) => void> = [];

  constructor({
    ptyFactory,
    now = () => Date.now(),
    maxLogBytes = DEFAULT_MAX_LOG_BYTES,
    isProcessAlive = processIsAlive,
    screenFactory,
    newSessionId = () => randomUUID(),
  }: SessionManagerDeps) {
    this.ptyFactory = ptyFactory;
    this.now = now;
    this.maxLogBytes = maxLogBytes;
    this.isProcessAlive = isProcessAlive;
    this.screenFactory = screenFactory ?? null;
    this.newSessionId = newSessionId;
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
    sessionId,
    resume,
    noResume,
  }: CreateSessionOptions = {}): Session {
    const id = `s${this.nextId++}`;
    const pty = this.ptyFactory({ shell, args, cwd, cols, rows, env });
    // 判定のための画面。記録の末尾ではなく、いま見えているものを見る（#31）
    const screen = this.screenFactory?.({ cols, rows }) ?? null;
    if (screen) this.screens.set(id, screen);
    const command = normalizeCommand(initialCommand);
    // 未知の id はここで既定へ寄せる。以降は必ず実在するプロファイルを指す
    const profile = resolveProfile(agent);

    // 会話を指定して起こす（#33）。**再開しないと言われたら渡された id は
    // 捨てて新しく始める** —— 記録が無いペインは再開できないため
    const mode = sessionId && resume !== false ? "resume" : "start";
    const chosen = mode === "resume" ? sessionId : this.newSessionId();
    // **打つものと、覚えておくものは別。** `initialCommand` は人が頼んだ形の
    // まま保つ（これが構成に保存される）。会話の id を焼き付けると、次の復元で
    // 再開の呼び方が使われず、同じ会話を始める形で起こそうとして落ちる
    const launch = sessionCommand({
      command,
      flags: profile.sessionFlags,
      sessionId: chosen,
      mode,
    });
    // 添えられなかったなら、この会話を覚えておく意味が無い（素のシェル・
    // 宣言しないプロファイル・人が自分で会話を指している指定）
    const liveSessionId = launch !== command ? chosen : undefined;

    const session: LiveSession = {
      id,
      title: title || defaultTitle(cwd),
      cwd,
      shell,
      args,
      cols,
      rows,
      initialCommand: command,
      sessionId: liveSessionId,
      noResume,
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
      screen?.write(data);
      session.lastOutputAt = this.now();
      this.dataHandlers.forEach((cb) => cb(id, data));
    });

    pty.onExit(({ exitCode }) => {
      session.exited = true;
      session.exitCode = exitCode;
      this.exitHandlers.forEach((cb) => cb(id, exitCode));
    });

    // ハンドラ登録後に流し込む。これで起動コマンド自身のエコーもログに載る。
    if (launch) pty.write(`${launch}\r`);

    return this._snapshot(session);
  }

  /**
   * ペインの題を付け替える（#28）。
   *
   * トリガーの送り先は題で指すが、既定の題は作業ディレクトリの末尾なので、
   * 同じディレクトリで役割の違う 2 枚を開くと衝突する。
   *
   * 題は 1 行であること。改行が混ざると表示も宛先の一致判定も壊れるので均す。
   * 空にしたら作業ディレクトリ由来の既定へ戻す（題なしでは指せない）。
   * **終了済みでも変えられる** — 題は表示と宛先のためのもので、pty を触らない。
   */
  rename(id: string, title: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    const cleaned = String(title ?? "")
      .replace(CONTROL_CHARS, " ")
      .replace(/\s+/g, " ")
      .trim();

    session.title = cleaned === "" ? defaultTitle(session.cwd) : cleaned;
    return true;
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
    // 複数を受け取れる。テキストは「指示待ち」だけ、キーは「指示待ち」と
    // 「確認待ち」の両方、のように送るものによって対象が変わる（#27）
    const allowed = onlyStatus === undefined ? null : [onlyStatus].flat();
    const targets = ids ?? [...this.sessions.keys()];
    const filtered = allowed
      ? targets.filter((id) => {
          const status = this.get(id)?.status;
          return status !== undefined && allowed.includes(status);
        })
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
   *
   * 寸法が変わらない要求は pty に渡さない。Windows の ConPTY は消えた
   * プロセスをリサイズすると戻ってこず、node-pty の resize はメインプロセスの
   * 上で同期的に走るのでアプリ全体が固まる（#16）。効果のない呼び出しを
   * 重ねるだけ危険が増える。
   *
   * onExit は実際の終了より遅れて届くので、フラグに加えてプロセスの生死も
   * 見る。ここを抜けた直後に終了する可能性までは消せないが、隙間は狭まる。
   */
  resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (!session || session.exited) return false;
    if (session.cols === cols && session.rows === rows) return true;

    const pid = session.pty.pid;
    if (pid !== undefined && !this.isProcessAlive(pid)) return false;

    session.cols = cols;
    session.rows = rows;
    session.pty.resize(cols, rows);
    // 画面にも伝える。折り返しが変わると、見えている内容そのものが変わる
    this.screens.get(id)?.resize(cols, rows);
    return true;
  }

  close(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.pty.kill();
    // 画面は行数ぶんの記憶を抱えるので、閉じたら必ず手放す
    this.screens.get(id)?.dispose();
    this.screens.delete(id);
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
      sessionId: session.sessionId,
      noResume: session.noResume,
      exited: session.exited,
      exitCode: session.exitCode,
      status: detectStatus({
        // 画面があればそれを見る。無ければ記録の末尾（従来どおり）。
        // 記録の末尾は「最後に塗られた場所」であって画面ではない（#31）
        tail: this.screens.get(session.id)?.read() ?? session.log.slice(-TAIL_CHARS),
        msSinceLastOutput: this.now() - session.lastOutputAt,
        exited: session.exited,
        waitingPatterns: session.profile.waitingPatterns,
        readyPatterns: session.profile.readyPatterns,
        askingPatterns: session.profile.askingPatterns,
      }),
    };
  }
}
