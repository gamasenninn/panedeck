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
 */

import fs from "fs";

import { renderTemplate, templateValues } from "./trigger-template";

/** 送ってよい状態。**指示待ちだけ**（#27） */
const DELIVERABLE = "ready";

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
  /** まだ届けていない行数 */
  held: number;
  /** 届けられない理由。無ければ空 */
  error: string;
}

export interface TriggerWatcherDeps {
  /** 題に当たるペインをすべて返す */
  findPane: (title: string) => PaneRef[];
  /** ペインへ打ち込む（確定の CR も含めて呼び出し側が決める） */
  send: (id: string, text: string) => void;
  /** ファイルの読み取り。テストから差し替えられるように */
  readFile?: (file: string) => string;
  /** ファイルの大きさ。無ければ null */
  sizeOf?: (file: string) => number | null;
}

interface Entry {
  config: TriggerConfig;
  /** どこまで読んだか（バイトではなく文字数） */
  cursor: number;
  held: string[];
  error: string;
}

export class TriggerWatcher {
  private entries: Entry[] = [];
  private findPane: (title: string) => PaneRef[];
  private sendTo: (id: string, text: string) => void;
  private readFile: (file: string) => string;
  private sizeOf: (file: string) => number | null;

  constructor({ findPane, send, readFile, sizeOf }: TriggerWatcherDeps) {
    this.findPane = findPane;
    this.sendTo = send;
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
      held: [],
      error: "",
    });
  }

  /** 差分を読み、送れるものを送る。 */
  check(): void {
    for (const entry of this.entries) {
      entry.error = "";
      this.collect(entry);
      this.deliver(entry);
    }
  }

  /** 画面に出すための状態。 */
  state(): TriggerState[] {
    return this.entries.map((entry) => ({
      watch: entry.config.watch,
      title: entry.config.pane.title,
      held: entry.held.length,
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
    let text: string;
    try {
      text = this.readFile(entry.config.watch);
    } catch {
      entry.error = `ファイルを読めません: ${entry.config.watch}`;
      return;
    }

    // 短くなっていたら別のファイルに入れ替わったとみなし、先頭から読み直す。
    // 進んだままにすると、以後の行を永久に取りこぼす
    if (text.length < entry.cursor) entry.cursor = 0;

    const added = text.slice(entry.cursor);
    entry.cursor = text.length;
    if (added === "") return;

    for (const line of added.split(/\r?\n/)) {
      if (line.trim() !== "") entry.held.push(line);
    }
  }

  /** 送れる状態なら、保留をまとめて 1 通で送る。 */
  private deliver(entry: Entry): void {
    const panes = this.findPane(entry.config.pane.title);

    if (panes.length === 0) {
      entry.error = `ペインがありません: ${entry.config.pane.title}`;
      return;
    }
    if (panes.length > 1) {
      // どちらへ送るか決められない。手当たり次第に送ると、意図しない相手が動く
      entry.error = `同じ題のペインが ${panes.length} あります: ${entry.config.pane.title}`;
      return;
    }

    if (entry.held.length === 0) return;

    const pane = panes[0];
    // 指示待ちのときだけ。確認待ちへ送ると、打った文字が回答になる（#27）
    if (pane.status !== DELIVERABLE) return;

    const text = renderTemplate(entry.config.send, templateValues(entry.held));
    entry.held = [];
    this.sendTo(pane.id, text);
  }
}
