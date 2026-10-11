/**
 * PaneDeck の受け渡しに使う形の定義。
 *
 * main / preload / renderer / workspace は同じセッションの形を扱うが、実体は
 * IPC を挟むので実行時の検査が無い。項目を1つ足すたびに4箇所を手で漏れなく
 * 触る必要があったため、形をここに1つだけ置いて全員がこれを参照する。
 */

/** セッションの状態 */
/**
 * `waiting` は「入力待ち」をひとまとめにした従来の状態。見分けられる
 * プロファイルでは `ready`（入力欄で待っている）と `asking`（質問で
 * 止まっている）に分かれる。見分けられないものは `waiting` のまま（#27）。
 */
export type SessionStatus =
  | "running"
  | "waiting"
  | "ready"
  | "asking"
  | "idle"
  | "exited";

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
  /** このペインの会話の id（#33）。会話を持たないペインでは無い */
  sessionId?: string;
  /**
   * このペインは会話を再開しない（#33）。
   *
   * **印は生き残らなければ意味が無い。** 保存して復元してまた保存する間に
   * 落ちると、次の起動で勝手に再開し始める
   */
  noResume?: boolean;
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
  /** 戻る先の会話の id（#33）。復元のときに渡す */
  sessionId?: string;
  /**
   * 会話を再開するか（#33）。
   *
   * `false` なら、渡された id は捨てて**新しい会話で始める**。記録が
   * 残っていないペイン、再開しない設定のペインで使う。
   */
  resume?: boolean;
  /** このペインは会話を再開しない（#33） */
  noResume?: boolean;
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

/**
 * 会話を指定して起動するための呼び方（#33）。`{id}` が会話の id に置き換わる。
 *
 * **初回と再開で別の呼び方が要る。** 実測（claude 2.1.288）では、同じ
 * `--session-id` を 2 回使うと `Session ID ... is already in use.` で落ちる。
 */
export interface SessionFlags {
  /** 新しい会話を始める形 */
  start: string;
  /** 会話を再開する形 */
  resume: string;
}

/** 判定パターン込みのプロファイル（メインプロセス内でのみ使う） */
export interface AgentProfile extends AgentProfileSummary {
  /** 何かが待っていると分かる印。分割できないときはこれだけを使う */
  waitingPatterns: RegExp[];
  /**
   * 入力欄で待っていると分かる印（#27）。
   * **カーソルだけでは足りない** —— 選択式ダイアログにも同じ記号が出るため、
   * 「入力欄だと言える」印（通常プロンプトのフッターなど）を入れること
   */
  readyPatterns?: RegExp[];
  /** 質問で止まっていると分かる印（#27）。これがあるときだけ分割が働く */
  askingPatterns?: RegExp[];
  /**
   * 会話を指定して起動するための呼び方（#33）。
   *
   * **初回と再開で呼び方が違う。** 同じ呼び方では 2 回目が落ちる
   * （claude は `Session ID ... is already in use.`）。
   * 宣言しないプロファイルは従来どおり起動する。
   */
  sessionFlags?: SessionFlags;
  /**
   * 会話の記録がある場所（#33）。再開できるかを事前に調べるために使う。
   *
   * **符号化の作法はここに閉じる。** PaneDeck に知らせると、エージェントを
   * 増やすたびに PaneDeck を直すことになる。宣言しなければ調べずに、
   * 失敗したときの退避だけに頼る。
   */
  recordFile?: (cwd: string, sessionId: string) => string;
}

/** node-pty のうち SessionManager が使う部分。テストのフェイクもこの形 */
export interface Pty {
  /** 起動したプロセスの pid。フェイクには無いので任意 */
  readonly pid?: number;
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
  /** このペインの会話の id（#33） */
  sessionId?: string;
  /** このペインは会話を再開しない（#33） */
  noResume?: boolean;
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
  /**
   * このペインの会話の id（#33）。
   *
   * **ペインと組で保存され、組で復元される。** 題を鍵にすると重なった
   * ときに決められず、ペインの id は起動ごとに振り直されるので跨げない。
   */
  sessionId?: string;
  /** このペインは会話を再開しない（#33）。受付のような常駐には向かない */
  noResume?: boolean;
}

export interface Workspace {
  version: number;
  name: string;
  sessions: WorkspaceEntry[];
}

/**
 * アプリ設定。ワークスペース（どこで開くか）とは別で、押さなくても次回に残るもの。
 */
/** ファイルが伸びたら指示待ちのペインへ伝える設定（#28） */
export interface TriggerConfig {
  /** 監視するファイル */
  watch: string;
  /** 送り先。題で指す（作業ディレクトリは複数のペインで重なりうる） */
  pane: { title: string };
  /** 送る文面のひな型。`{count}` と最後の行の最上位フィールドが使える */
  send: string;
  /**
   * 配達の上限（#34 の合意 ①）。`minutes` 分の間に `count` 回まで打つ。
   * 超えたら配らずに保留し、**人が解除するまで**次を打たない。
   *
   * 書かなければ掛からない。Tealus のトリガーには掛けない —— 人の普通の
   * 会話が 10 分に 6 回の縁にいた（10/7 の実測）
   */
  limit?: TriggerLimit;
}

export interface TriggerLimit {
  count: number;
  minutes: number;
}

/** 画面に出すためのトリガーの様子（#28） */
export interface TriggerState {
  watch: string;
  title: string;
  /** まだ届けていない行数 */
  held: number;
  /** 届けられない理由。無ければ空 */
  error: string;
  /** 上限に当たって止めている。人が解除するまで戻らない（#34 の合意 ③） */
  capped: boolean;
}

/** 裏で走らせ続けるコマンド（#29） */
/**
 * 起動の引数で開いたフォルダ（2026-10-11）。VS Code の `code <フォルダ>` と同じ考えで、
 * 新しいペインも裏のコマンドもそこで動く
 */
export interface OpenFolder {
  /** 開いたフォルダ（絶対パス） */
  folder?: string;
  /** 渡されたが、フォルダとして開けなかった場所。黙って今までどおりに起動しない */
  missing?: string;
}

export interface ServiceConfig {
  /** 画面に出す名前。ログの宛先でもあるので重複させない */
  name: string;
  command: string;
  /** 既定は always */
  restart: "always" | "never";
}

/** 画面に出すためのサービスの様子（#29） */
export interface ServiceState {
  name: string;
  /** running / restarting / stopped */
  status: "running" | "restarting" | "stopped";
  /** 続けて落ちた回数。走り続けられたら 0 に戻る */
  restarts: number;
  lastExitCode: number | null;
}

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
  /** ファイル監視のトリガー（#28） */
  triggers: TriggerConfig[];
  /** 監視ファイルごとに、どこまで届けたか。再起動で飛ばさないため */
  triggerCursors: Record<string, number>;
  /**
   * 郵便受けをペインごとに自動で作る（#34）。`<userData>/mailbox/<題>.jsonl` を
   * 見張り、上限 10 分に 6 回を必ず付ける。決まりは docs/mailbox.md
   */
  mailboxes: boolean;
  /** 裏で走らせ続けるコマンド（#29） */
  services: ServiceConfig[];
}

/** 一斉送信の絞り込み */
export interface BroadcastOptions {
  /** この状態のセッションだけに送る */
  onlyStatus?: SessionStatus | SessionStatus[];
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
  /** ペインの題を付け替える。空にすると作業ディレクトリ由来の既定へ戻る（#28） */
  renameSession(id: string, title: string): Promise<boolean>;
  broadcast(
    data: string,
    ids?: string[] | null,
    options?: BroadcastOptions
  ): Promise<number>;
  pickDirectory(): Promise<string | null>;

  listAgents(): Promise<AgentProfileSummary[]>;
  /** トリガーの様子。保留件数と、届けられない理由（#28） */
  listTriggers(): Promise<TriggerState[]>;
  /** 動いているのが古いビルドか。中身で比べる（2026-10-10） */
  isStale(): Promise<boolean>;
  /** 起動の引数で開いたフォルダ（2026-10-11）。開いていなければ空 */
  openFolder(): Promise<OpenFolder>;
  /** メインプロセスからの知らせ（2 つ目を起動しなかった、など） */
  onNotice(cb: (text: string) => void): void;
  /** 全終了の直前の構成が何個ぶん残っているか（2026-10-09） */
  countPrevious(): Promise<number>;
  /** 全終了の直前の構成に戻す。人が押したときだけ */
  restorePrevious(): Promise<{ ok: true; sessions: Session[] } | { ok: false; error: string }>;
  /** 上限で止めたトリガーを解除する。人が押したときだけ（#34 の合意 ③） */
  releaseTrigger(watch: string): Promise<boolean>;
  /** 裏のコマンドの様子。落ち続けていることを隠さない（#29） */
  listServices(): Promise<ServiceState[]>;
  /** 裏のコマンドの出力。ペインへは流さず、ここで見る（#29） */
  getServiceLog(name: string): Promise<string>;

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
  /** 保存された構成をそのまま復元する。ツールバーの値は混ぜない（#26） */
  restoreWorkspace(): Promise<RestoreResult>;
}
