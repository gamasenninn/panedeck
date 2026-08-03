/**
 * スクリプトタグやテストの仕込みで現れるグローバルの宣言。
 *
 * どれも実行時には既に存在するが、型検査からは見えないのでここで教える。
 */

import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";
import type { DeckApi } from "./panedeck";

declare global {
  /** index.html が読み込む xterm.js が window に置く */
  const Terminal: typeof XTerm;

  /** addon-fit は名前空間ごと window に置く（`new FitAddon.FitAddon()`） */
  const FitAddon: { FitAddon: typeof XFitAddon };

  interface Window {
    /** preload が contextBridge で公開する API */
    deck: DeckApi;
  }

  /**
   * E2E がメインプロセスへ仕込む足場。
   *
   * `electronApp.evaluate()` の中で参照するため、テストからは通常のコードとして
   * 型検査される。実体はテストヘルパーが差し込む。
   */
  // eslint-disable-next-line no-var
  var __sessionManager: any;
  var __fakePtys: any[];
  var __clock: number;

  /** pane-sync.spec.js がログ取得を保留させるためのゲート */
  var __logGate: Array<() => void>;
  var __logCalls: string[];
  var __listCount: number;
}

export {};
