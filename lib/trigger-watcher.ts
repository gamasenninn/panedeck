/**
 * ファイルが伸びたら、指示待ちのペインへ 1 通送る（#28）。
 *
 * **中身は一切解釈しない。** 「ファイルが伸びた → 指示待ちのペインに伝える」
 * だけを担う。何が書いてあるかは送られた側が決める。
 *
 * Electron にも pty にも依存しない。ペインの探索と送信は注入されるので、
 * フェイクを渡せば実プロセス無しで「いつ・何通」を検証できる。
 *
 * 監視そのもの（いつ `check()` を呼ぶか）は外側の仕事。ここは呼ばれたときに
 * 差分を読んで、送れるなら送る。
 *
 * ## 打つことと、確定することは別の出来事
 *
 * **文面と確定の CR を一度に書いてはいけない。** Claude Code は塊で届いた
 * 入力を貼り付けと見て、末尾の CR を**改行として入れる** —— 文面は入力欄に
 * 残り、実行されない。実測（文面 91 文字）では**一度に送ると 0/4、分けて
 * 送ると 4/4**。短い文面では起きないので、長さで変わる。
 *
 * 人が使うときは「文字を入れる」「Enter を押す」が別の出来事になっている。
 * だから**手で操作している限りこの不具合は出ない**。ここだけが一度に
 * 送っていた。
 *
 * ## 送っただけでは届いたと言わない
 *
 * 以前は書いた時点でカーソルを進めていた。実行されなければ**行は消費され、
 * 文面は入力欄に残り、何も起きない** —— この機能が取り除こうとした
 * 「黙って何もしない」そのもの。いまはペインが動いたのを見てから進める。
 */

import fs from "fs";

import { renderTemplate, templateValues } from "./trigger-template";

/** 送ってよい状態。**指示待ちだけ**（#27） */
const DELIVERABLE = "ready";

/**
 * 文面を打ってから確定の CR を送るまでの間隔 (ms)。
 *
 * 貼り付けと見なされる窓を越えるため。実測で 0ms は 0/4、500ms は 4/4。
 * **縮めるときは必ず実機で測り直すこと** —— 失敗しても「打てている」ので、
 * テストでは見つからない。
 */
export const SUBMIT_DELAY_MS = 500;

/**
 * 確定を送ってから「実行された」と判断するまで待つ時間 (ms)。
 *
 * ペインが指示待ちから動けば実行された証拠。この時間を過ぎても指示待ちの
 * ままなら、CR が飲まれたとみなして押し直す。
 */
export const CONFIRM_MS = 4_000;

/** CR を押す回数の上限。これを越えたら諦めて、保留に戻して人に知らせる */
export const MAX_SUBMITS = 3;

export interface TriggerConfig {
  /** 監視するファイル */
  watch: string;
  /** 送り先のペイン。題で指定する（作業ディレクトリは複数のペインで重なる） */
  pane: { title: string };
  /** 送る文面のひな型。`{count}` と、最後の行の最上位フィールドが使える */
  send: string;
}

export interface PaneRef {
  id: string;
  title: string;
  status: string;
}

export interface TriggerState {
  watch: string;
  title: string;
  /** まだ届いていない行数（打った直後の確認中も含む） */
  held: number;
  /** 届けられない理由。無ければ空 */
  error: string;
}

export interface TriggerWatcherDeps {
  /** 題に当たるペインをすべて返す */
  findPane: (title: string) => PaneRef[];
  /** ペインへ文面を打つ。**確定はしない** */
  type: (id: string, text: string) => void;
  /** 確定の CR を送る。打つのとは別の出来事として扱う */
  submit: (id: string) => void;
  /** 時刻。テストから差し替えられるように */
  now?: () => number;
  /** ファイルの読み取り。テストから差し替えられるように */
  readFile?: (file: string) => string;
  /** ファイルの大きさ（**文字数**）。追いかけ始める位置を決めるのに使う */
  sizeOf?: (file: string) => number | null;
  /**
   * ファイルのバイト数（#35）。**読まずに済ませるため**に使う。
   *
   * 文字数の `sizeOf` と別にしているのは、あちらが中身を読んで数えるから。
   * ここは `stat` で足りる（マイクロ秒）。
   */
  byteSizeOf?: (file: string) => number | null;
}

/** 打ったが、まだ実行を確かめていない 1 通 */
interface Pending {
  paneId: string;
  /** 諦めるときに保留へ戻すための元の行 */
  lines: string[];
  typedAt: number;
  /** 確定を送った時刻。まだなら null */
  submittedAt: number | null;
  submits: number;
}

interface Entry {
  config: TriggerConfig;
  /** どこまで読んだか（バイトではなく文字数） */
  cursor: number;
  /**
   * どこまで読んだか。**カーソルとは別に持つ。**
   *
   * カーソルは「届けた位置」で、保留したまま閉じた行を次の起動で拾い直せる
   * ようにするためのもの。読んだ時点で進めると、保留はメモリにしか無いので
   * そのまま消える。
   */
  readTo: number;
  held: string[];
  error: string;
  /**
   * 最後に見たバイト数（#35）。変わっていなければ読まない。
   *
   * **追記だけの queue なら、これで取りこぼさない。** 同じ大きさのまま
   * 中身が入れ替わる書き方には気づけないが、それは以前の「短くなったら
   * 入れ替わり」の判定でも拾えていなかった。
   */
  lastBytes: number | null;
  pending: Pending | null;
  /**
   * 諦めた後、ペインが動くまで打ち直さない。
   *
   * 入力欄に文面が残っているので、重ねて打つと繋がって意味をなさなくなる。
   * 人が片付けるか、ペインが何か動けば再開する。
   */
  stuck: boolean;
}

export class TriggerWatcher {
  private entries: Entry[] = [];
  private findPane: (title: string) => PaneRef[];
  private typeInto: (id: string, text: string) => void;
  private submitTo: (id: string) => void;
  private now: () => number;
  private readFile: (file: string) => string;
  private sizeOf: (file: string) => number | null;
  private byteSizeOf: (file: string) => number | null;

  constructor({
    findPane,
    type,
    submit,
    now,
    readFile,
    sizeOf,
    byteSizeOf,
  }: TriggerWatcherDeps) {
    this.findPane = findPane;
    this.typeInto = type;
    this.submitTo = submit;
    this.now = now ?? (() => Date.now());
    this.readFile = readFile ?? ((file) => fs.readFileSync(file, "utf8"));
    this.sizeOf =
      sizeOf ??
      ((file) => {
        try {
          return fs.readFileSync(file, "utf8").length;
        } catch {
          return null;
        }
      });
    this.byteSizeOf =
      byteSizeOf ??
      ((file) => {
        try {
          return fs.statSync(file).size;
        } catch {
          return null;
        }
      });
  }

  /**
   * トリガーを足す。
   *
   * `cursor` を渡さなければ**いまの末尾から**追いかける。既にある行を
   * 送りつけないため。預けたカーソルがあるときだけ、そこから再開する。
   */
  add(config: TriggerConfig, cursor?: number): void {
    const size = this.sizeOf(config.watch);
    this.entries.push({
      config,
      cursor: cursor ?? (size ?? 0),
      readTo: cursor ?? (size ?? 0),
      held: [],
      error: "",
      lastBytes: null,
      pending: null,
      stuck: false,
    });
  }

  /** 差分を読み、送れるものを送る。 */
  check(): void {
    for (const entry of this.entries) {
      entry.error = "";
      this.collect(entry);
      if (entry.pending) this.progress(entry);
      else this.deliver(entry);
    }
  }

  /** 画面に出すための状態。 */
  state(): TriggerState[] {
    return this.entries.map((entry) => ({
      watch: entry.config.watch,
      title: entry.config.pane.title,
      // 確認中の行も「まだ届いていない」。送った数ではなく届いた数を出す
      held: entry.held.length + (entry.pending?.lines.length ?? 0),
      error: entry.error,
    }));
  }

  /** 保存しておくカーソル。次の起動でここから再開する */
  cursors(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const entry of this.entries) out[entry.config.watch] = entry.cursor;
    return out;
  }

  /** 増えた行を保留へ移す。 */
  private collect(entry: Entry): void {
    // **変わっていなければ読まない（#35）。** 以前は 300ms ごとに丸ごと
    // 読み直していて、10 MB のファイルで 1 コアの 3.6% を常時使っていた。
    // `stat` はマイクロ秒で済み、普段ファイルは変わらない。
    //
    // 大きさが取れないときは読みにいく —— 読めない理由を毎回出すため
    const bytes = this.byteSizeOf(entry.config.watch);
    if (bytes !== null && bytes === entry.lastBytes) return;
    entry.lastBytes = bytes;

    let text: string;
    try {
      text = this.readFile(entry.config.watch);
    } catch {
      entry.error = `ファイルを読めません: ${entry.config.watch}`;
      return;
    }

    // 短くなっていたら別のファイルに入れ替わったとみなし、先頭から読み直す。
    // 進んだままにすると、以後の行を永久に取りこぼす
    if (text.length < entry.readTo) {
      entry.readTo = 0;
      entry.cursor = 0;
    }

    const added = text.slice(entry.readTo);
    entry.readTo = text.length;
    if (added === "") return;

    for (const line of added.split(/\r?\n/)) {
      if (line.trim() !== "") entry.held.push(line);
    }
  }

  /**
   * 送り先のペインを 1 枚に決める。決められないときは理由を残して null。
   */
  private resolvePane(entry: Entry): PaneRef | null {
    const panes = this.findPane(entry.config.pane.title);

    if (panes.length === 0) {
      entry.error = `ペインがありません: ${entry.config.pane.title}`;
      return null;
    }
    if (panes.length > 1) {
      // どちらへ送るか決められない。手当たり次第に送ると、意図しない相手が動く
      entry.error = `同じ題のペインが ${panes.length} あります: ${entry.config.pane.title}`;
      return null;
    }
    return panes[0];
  }

  /** 送れる状態なら、保留をまとめて 1 通で打つ（確定はまだしない）。 */
  private deliver(entry: Entry): void {
    const pane = this.resolvePane(entry);
    if (!pane) return;

    // ペインが動いたら、詰まりは解けたとみなして再開する
    if (entry.stuck && pane.status !== DELIVERABLE) entry.stuck = false;

    if (entry.held.length === 0) return;

    if (entry.stuck) {
      entry.error = `実行されませんでした。入力欄を片付けてください: ${entry.config.pane.title}`;
      return;
    }

    // 指示待ちのときだけ。確認待ちへ送ると、打った文字が回答になる（#27）
    if (pane.status !== DELIVERABLE) return;

    const lines = entry.held;
    const text = renderTemplate(entry.config.send, templateValues(lines));
    entry.held = [];
    entry.pending = {
      paneId: pane.id,
      lines,
      typedAt: this.now(),
      submittedAt: null,
      submits: 0,
    };
    this.typeInto(pane.id, text);
  }

  /**
   * 打った 1 通を、確定 → 実行の確認まで進める。
   */
  private progress(entry: Entry): void {
    const pending = entry.pending!;
    const pane = this.resolvePane(entry);

    // 送り先が消えた。打った行を保留へ戻す（消さない）
    if (!pane) {
      entry.held = [...pending.lines, ...entry.held];
      entry.pending = null;
      return;
    }

    // まだ確定していない。貼り付けと見なされる窓を越えてから押す
    if (pending.submittedAt === null) {
      if (this.now() - pending.typedAt < SUBMIT_DELAY_MS) return;
      pending.submittedAt = this.now();
      pending.submits = 1;
      this.submitTo(pending.paneId);
      return;
    }

    // ペインが動いた＝実行された。ここで初めてカーソルを進める
    if (pane.status !== DELIVERABLE) {
      entry.cursor = entry.readTo;
      entry.pending = null;
      return;
    }

    if (this.now() - pending.submittedAt < CONFIRM_MS) return;

    // 指示待ちのまま動かない。CR が飲まれたとみなして押し直す
    if (pending.submits < MAX_SUBMITS) {
      pending.submittedAt = this.now();
      pending.submits += 1;
      this.submitTo(pending.paneId);
      return;
    }

    // 諦める。**行は保留へ戻す**（送ったことにして消さない）
    entry.held = [...pending.lines, ...entry.held];
    entry.pending = null;
    entry.stuck = true;
    entry.error = `実行されませんでした。入力欄を片付けてください: ${entry.config.pane.title}`;
  }
}
