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

import { idProblem, renderTemplate, templateValues } from "./trigger-template";

/** 送ってよい状態。**指示待ちだけ**（#27） */
const DELIVERABLE = "ready";

/**
 * 改行で終わらない断片を、理由として出すまでの猶予。
 *
 * 書き手が 1 行を 2 回に分けて書くのは普通のことで、数百ミリ秒で完成する。
 * **完成しないまま止まったときだけ**出したいので、十分に長く取る。
 */
export const PARTIAL_WARN_MS = 10_000;

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
  /**
   * 出来事を知らせる（#36）。
   *
   * ツールバーは「いま」を描くだけなので、**直れば証拠が消え、閉じれば
   * 全部消える**。後から読めるように、**変わった瞬間だけ**を外へ出す。
   * 毎周の状態は出さない（300ms × 枚数を書けば読めない量になる）。
   */
  onEvent?: (event: { kind: string } & Record<string, unknown>) => void;
}

/** 打ったが、まだ実行を確かめていない 1 通 */
interface Pending {
  paneId: string;
  /** 諦めるときに保留へ戻すための元の行 */
  lines: string[];
  /** いちばん古い行が積まれた時刻。**保留の長さがここから出る**（#36） */
  heldSince: number;
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
  /** いちばん古い保留が積まれた時刻（#36）。空になったら消す */
  heldSince: number | null;
  error: string;
  /** 前回知らせた理由。**変わったときだけ**知らせるため（#36） */
  reported: string;
  /**
   * 最後に見たバイト数（#35）。変わっていなければ読まない。
   *
   * **追記だけの queue なら、これで取りこぼさない。** 同じ大きさのまま
   * 中身が入れ替わる書き方には気づけないが、それは以前の「短くなったら
   * 入れ替わり」の判定でも拾えていなかった。
   */
  lastBytes: number | null;
  /**
   * 改行で終わらない断片を抱え始めた時刻。無ければ null。
   *
   * **黙って抱えないため**だけに持つ。#35 で「変わっていなければ読まない」
   * ので、断片のまま止まった書き手は**何も起きないまま静かに待たれる**。
   */
  partialSince: number | null;
  /**
   * id が識別子の形でなく、打たなかった行の数（#34 の合意 ⑥）。
   *
   * **起動している間は消さない。** 正しい便が後から来ても消すと、混ぜて
   * 送られたときに見えなくなる。人が解除する仕組み（#34 の ③）ができたら、
   * そちらで消す。記録（`trigger-rejected`）には 1 件ずつ残る
   */
  rejected: number;
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
  private onEvent: (event: { kind: string } & Record<string, unknown>) => void;

  constructor({
    findPane,
    type,
    submit,
    now,
    readFile,
    sizeOf,
    byteSizeOf,
    onEvent,
  }: TriggerWatcherDeps) {
    this.onEvent = onEvent ?? (() => {});
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
      heldSince: null,
      error: "",
      reported: "",
      lastBytes: null,
      partialSince: null,
      rejected: 0,
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
      this.reportPartial(entry);
      this.reportRejected(entry);
      this.reportError(entry);
    }
  }

  /**
   * 完成しない断片を抱えていることを理由にする。
   *
   * **ここは毎周走らないといけない。** `collect()` は大きさが変わらなければ
   * 先頭で戻るので（#35）、断片のまま止まった書き手の回には入ってこない。
   *
   * 他に理由があるときは譲る —— 届け先が無いほうが、人にとって直せる話。
   */
  private reportPartial(entry: Entry): void {
    if (entry.error !== "" || entry.partialSince === null) return;
    if (this.now() - entry.partialSince < PARTIAL_WARN_MS) return;
    entry.error = `行が改行で終わっていません（続きを待っています）: ${entry.config.watch}`;
  }

  /**
   * 打たなかった行があることを理由にする（#34 の合意 ⑥）。
   *
   * 他に理由があるときは譲る。届け先が無い・続きを待っている、のほうが
   * いま直せる話で、こちらは起きたことの知らせだから。
   */
  private reportRejected(entry: Entry): void {
    if (entry.error !== "" || entry.rejected === 0) return;
    entry.error = `id が識別子の形でない行を ${entry.rejected} 件配りませんでした: ${entry.config.watch}`;
  }

  /**
   * 理由が**変わったときだけ**知らせる（#36）。
   *
   * 届け先が無い状態は 300ms ごとに続くので、毎周出したら読めない量になる。
   * 直ったことも 1 行出す —— そうしないと「いつ直ったか」が分からない。
   */
  private reportError(entry: Entry): void {
    if (entry.error === entry.reported) return;
    const was = entry.reported;
    entry.reported = entry.error;

    if (entry.error !== "") {
      this.onEvent({
        kind: "trigger-error",
        watch: entry.config.watch,
        title: entry.config.pane.title,
        reason: entry.error,
      });
    } else if (was !== "") {
      this.onEvent({
        kind: "trigger-ok",
        watch: entry.config.watch,
        title: entry.config.pane.title,
      });
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

    let text: string;
    try {
      text = this.readFile(entry.config.watch);
    } catch {
      entry.error = `ファイルを読めません: ${entry.config.watch}`;
      return;
    }

    // **読めてから進める。** 読む前に進めると、大きさは取れるが読めない
    // ファイル（権限・ロック）で次の回が飛ばされ、`check()` の頭で理由が
    // 消される —— 300ms だけ出て、あとは黙ることになる
    entry.lastBytes = bytes;

    // 短くなっていたら別のファイルに入れ替わったとみなし、先頭から読み直す。
    // 進んだままにすると、以後の行を永久に取りこぼす
    if (text.length < entry.readTo) {
      entry.readTo = 0;
      entry.cursor = 0;
    }

    const added = text.slice(entry.readTo);
    if (added === "") return;

    // **1 行は改行で終わって初めて 1 行。** 増えた分をそのまま切ると、書き手が
    // 1 行を 2 回に分けて書いた瞬間に挟まったポーリングが、1 件を「前半」
    // 「後半」の 2 件に割って配る。前半は JSON として読めないので id が取れない。
    //
    // だから**最後の改行より後ろは読んだことにしない**。次の回に回す。
    // ★ `readTo` を進めないことが肝で、進めると #35（変わっていなければ
    // 読まない）と合わさって断片が永久に捨てられる。
    const lastBreak = added.lastIndexOf("\n");
    if (lastBreak === -1) {
      entry.partialSince ??= this.now();
      return;
    }

    const complete = added.slice(0, lastBreak + 1);
    entry.readTo += lastBreak + 1;
    // 後ろにまだ断片が残っていれば抱えたまま。**いちばん古い時刻を保つ**
    entry.partialSince =
      entry.readTo < text.length ? entry.partialSince ?? this.now() : null;

    for (const line of complete.split(/\r?\n/)) {
      if (line.trim() !== "") {
        // **識別子の形をしていない id は打たない**（#34 の合意 ⑥）。
        // `{id}` は人が打った文として届くので、文章を入れられると受け手には
        // 人の指示と区別できない。打たずに数え、記録に残す（中身は写さない）
        const problem = idProblem(line, entry.config.send);
        if (problem !== null) {
          entry.rejected += 1;
          this.onEvent({
            kind: "trigger-rejected",
            watch: entry.config.watch,
            title: entry.config.pane.title,
            reason: problem,
          });
          continue;
        }

        // **いちばん古い行の時刻だけ覚える。** 配達の行に「どれだけ待ったか」
        // を入れれば、保留そのものを出来事にしなくて済む（#36）
        if (entry.heldSince === null) entry.heldSince = this.now();
        entry.held.push(line);
      }
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
      heldSince: entry.heldSince ?? this.now(),
      typedAt: this.now(),
      submittedAt: null,
      submits: 0,
    };
    entry.heldSince = null;
    this.typeInto(pane.id, text);
    this.onEvent({
      kind: "typed",
      watch: entry.config.watch,
      title: entry.config.pane.title,
      count: lines.length,
    });
  }

  /**
   * 打った 1 通を、確定 → 実行の確認まで進める。
   */
  private progress(entry: Entry): void {
    const pending = entry.pending!;
    const pane = this.resolvePane(entry);

    // 送り先が消えた、または**打ち込んだのとは別のペイン**になっている。
    //
    // 題は付け替えられる（#28）ので、打った後にそのペインが閉じ、別のペインが
    // 同じ題を名乗ることがある。そのペインが自分の仕事で動いているのを見て
    // 「実行された」と取り違えると、**行が消える**。
    //
    // 打った行は保留へ戻す（消さない）
    if (!pane || pane.id !== pending.paneId) {
      entry.held = [...pending.lines, ...entry.held];
      entry.heldSince = pending.heldSince;
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
      this.onEvent({
        kind: "delivery",
        watch: entry.config.watch,
        title: entry.config.pane.title,
        count: pending.lines.length,
        // **保留の有無と長さが、この 1 行で分かる**
        waitedMs: this.now() - pending.heldSince,
        // 押し直しで助かったなら、それもここに出る（#32）
        submits: pending.submits,
      });
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
    entry.heldSince = pending.heldSince;
    entry.pending = null;
    entry.stuck = true;
    this.onEvent({
      kind: "not-executed",
      watch: entry.config.watch,
      title: entry.config.pane.title,
      count: pending.lines.length,
      submits: pending.submits,
    });
    entry.error = `実行されませんでした。入力欄を片付けてください: ${entry.config.pane.title}`;
  }
}
