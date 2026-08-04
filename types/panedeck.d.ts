/**
 * PaneDeck の受け渡しに使う形の定義。
 *
 * main / preload / renderer / workspace は同じセッションの形を扱うが、実体は
 * IPC を挟むので実行時の検査が無い。項目を1つ足すたびに4箇所を手で漏れなく
 * 触る必要があったため、形をここに1つだけ置いて全員がこれを参照する。
 */

/** セッションの状態 */
export type SessionStatus = "running" | "waiting" | "idle" | "exited";

/**
 * IPC で送れる形のセッション（pty 本体を含まないスナップショット）。
 * `SessionManager._snapshot()` が返すもの。
 */
export interface Session {
  id: string;
  title: string;
  cwd?: string;
  shell?: string;
  args: string[];
  cols: number;
  rows: number;
  /** 起動直後に流し込むコマンド。空なら素のシェルのまま */
  initialCommand?: string;
  /** 入力待ちの判定に使うプロファイル id */
  agent: string;
  exited: boolean;
  exitCode: number | null;
  status: SessionStatus;
}

/** セッション生成時に渡せる項目 */
export interface CreateSessionOptions {
  cwd?: string;
  shell?: string;
  args?: string[];
  title?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  initialCommand?: string;
  agent?: string;
}

/**
 * レンダラへ渡すプロファイル。
 * 判定に使う正規表現は structured clone を通らないので含まない。
 */
export interface AgentProfileSummary {
  id: string;
  name: string;
  command: string;
}

/** 判定パターン込みのプロファイル（メインプロセス内でのみ使う） */
export interface AgentProfile extends AgentProfileSummary {
  waitingPatterns: RegExp[];
}

/** node-pty のうち SessionManager が使う部分。テストのフェイクもこの形 */
export interface Pty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (event: { exitCode: number }) => void): void;
}

/** pty 生成関数へ渡す引数 */
export interface PtyFactoryOptions {
  shell?: string;
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

/**
 * SessionManager が内部で保持する形。pty やログなど IPC に載せないものを含む。
 * 外へ出すときは `Session` へ落とす。
 */
export interface LiveSession {
  id: string;
  title: string;
  cwd?: string;
  shell?: string;
  args: string[];
  cols: number;
  rows: number;
  initialCommand?: string;
  profile: AgentProfile;
  pty: Pty;
  log: string;
  lastOutputAt: number;
  exited: boolean;
  exitCode: number | null;
}

/** ワークスペースに保存する1セッション分。実行時の情報は持たない */
export interface WorkspaceEntry {
  title?: string;
  cwd: string;
  shell?: string;
  args: string[];
  initialCommand?: string;
  agent?: string;
}

export interface Workspace {
  version: number;
  name: string;
  sessions: WorkspaceEntry[];
}

/**
 * アプリ設定。ワークスペース（どこで開くか）とは別で、押さなくても次回に残るもの。
 */
export interface Settings {
  /** 端末の文字サイズ (px) */
  fontSize: number;
  /** グリッドの列数。0 は幅に合わせた自動 */
  columns: number;
  /** 起動時に前回のセッション構成を自動で復元するか */
  autoRestore: boolean;
  /** セッションの出力をファイルへ書き出すか */
  autoLog: boolean;
  /** ログの出力先。空なら userData 配下の既定の場所 */
  logDir: string;
  /** ログから ANSI エスケープを落とすか */
  logStripAnsi: boolean;
  /** ログの保持日数。0 なら期間では消さない */
  logRetentionDays: number;
  /** ログの合計サイズ上限 (MB)。0 ならサイズでは消さない */
  logMaxTotalMB: number;
}

/** 一斉送信の絞り込み */
export interface BroadcastOptions {
  /** この状態のセッションだけに送る */
  onlyStatus?: SessionStatus;
}

/** ダイアログを伴う操作の結果 */
export interface FileResult {
  ok: boolean;
  filePath?: string;
  error?: string;
  canceled?: boolean;
}

export interface RestoreResult {
  ok: boolean;
  name?: string;
  sessions?: Session[];
  error?: string;
  canceled?: boolean;
}

/**
 * preload が contextBridge で公開する API。
 *
 * ここが main と renderer の境界。チャンネル名やペイロードの形を変えても
 * 実行時には何も起きず `undefined` が静かに流れるので、この定義に照らして
 * 呼び出し側を検査させる。
 */
export interface DeckApi {
  createSession(
    options: CreateSessionOptions
  ): Promise<{ ok: true; session: Session } | { ok: false; error: string }>;
  listSessions(): Promise<Session[]>;
  closeSession(id: string): Promise<boolean>;
  closeAllSessions(): Promise<number>;
  reorderSessions(ids: string[]): Promise<string[]>;
  broadcast(
    data: string,
    ids?: string[] | null,
    options?: BroadcastOptions
  ): Promise<number>;
  pickDirectory(): Promise<string | null>;

  listAgents(): Promise<AgentProfileSummary[]>;

  input(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;

  onSessionData(cb: (id: string, data: string) => void): void;
  onSessionExit(cb: (id: string, exitCode: number) => void): void;
  onLogError(
    cb: (failure: { id: string; filePath: string; error: string }) => void
  ): void;

  writeClipboard(
    text: string
  ): Promise<{ ok: true } | { ok: false; error: string }>;

  getSettings(): Promise<Settings>;
  setSettings(
    settings: Partial<Settings>
  ): Promise<{ ok: true; settings: Settings } | { ok: false; error: string }>;

  getLog(id: string): Promise<string>;
  saveLog(id: string): Promise<FileResult>;

  saveWorkspace(name: string): Promise<FileResult>;
  restoreWorkspace(options: {
    initialCommand?: string;
    agent?: string;
  }): Promise<RestoreResult>;
}
