# PaneDeck - CLAUDE.md

## プロジェクト概要

複数のコーディングエージェント（Claude Code / Codex / Gemini CLI など）のセッションを
グリッド分割ペインで同時に走らせ、一括操作するための Electron ターミナルアプリ。
node-pty + xterm.js。

特定のエージェントに依存しない設計にする。起動コマンドは設定値であり、
状態判定のパターンも差し替え可能な形に保つこと。

主な機能:

- 複数ターミナルのグリッド表示（1〜N ペイン）
- 全ペイン / 選択ペインへの一斉入力（Broadcast）
- 各ペインへの個別 sendkey（Enter / Esc / Ctrl+C / 矢印など）
- 各セッションの状態可視化（running / waiting / idle / exited）
- 出力ログのファイル保存
- セッション構成（ワークスペース）の保存・復元

## 引き継ぎ

前セッションからの申し送り（設計判断の理由・再発しやすい落とし穴・次の作業候補）は
`docs/HANDOVER.md` にある。**作業を始める前に必ず目を通すこと。**

特に以下は事故りやすい:

- レンダラで `const deck = ...` と書くと contextBridge のグローバルと衝突してスクリプト
  全体が落ちる（`const api = window.deck` にしてある）
- E2E の `resetSessions()` には必ず `page` を渡す（渡さないと残骸ペインを掴む）
- `window.alert` は使わない（E2E がブロックする）。通知は `showMessage()` へ

## 開発方式: TDD 厳守

**すべての開発は TDD（テスト駆動開発）で行う。例外なし。**

### 開発サイクル: Plan → Test → Implement → Fix（自動反復）

1. **Plan** - 機能要件を整理し、テスト項目を設計する
2. **Red** - 失敗するテストを先に書く
3. **Green** - テストを通す最小限の実装を行う
4. **Refactor** - コードを整理する
5. **テスト実行** - 全テスト通過を確認する。失敗があれば修正して再実行
6. ステップ 2〜5 を機能完成まで繰り返す

### TDD ルール

- 実装コードを書く前に、必ず失敗するテストを書く
- テストが通る最小限の実装のみ行う（過剰実装しない）
- 全テスト通過を確認してからリファクタリングする
- テストなしのコードを本番に入れない

## コマンド

```bash
npm start          # アプリ起動
npm test           # 型検査 + 全テスト（unit + e2e）
npm run typecheck  # 型検査のみ（tsc --noEmit）
npm run test:unit  # ロジック単体テストのみ（高速）
npm run test:e2e   # Electron E2E テストのみ
npm run test:report  # HTML レポート表示
npm run rebuild    # node-pty を Electron ABI 向けに再ビルド
```

## 型検査（JS のまま TypeScript で検査する）

`tsconfig.json` は `allowJs` + `checkJs` + `noEmit`。**JS は 1 バイトも生成しない。**
ファイル名も実行時の挙動も変えずに型検査だけを受ける構成で、`npm test` の先頭で走る。

狙いは main ↔ preload ↔ renderer の境界。IPC は実行時の検査が無く、チャンネル名や
ペイロードの形が食い違っても `undefined` が静かに流れるだけなので、そこを型で押さえる。

- 受け渡しの形は `types/panedeck.d.ts` に1つだけ置く。`Session` に項目を足すときは
  ここを直せば、main / preload / renderer / workspace のどこで漏らしても検査で落ちる
- `types/globals.d.ts` は `window.deck`、xterm のグローバル、E2E が仕込む
  `global.__sessionManager` などの宣言
- JSDoc から型を参照するときは `/** @import * as Types from "../types/panedeck" */`
- `strict` / `noImplicitAny` / `strictNullChecks` は意図的に緩めてある。JSDoc 主体の
  コードでいきなり全部を厳格にすると、実害のある指摘が暗黙 any の山に埋もれるため
- テストが**わざと不正な値を渡す**箇所（`onlyStatus: "nonsense"` など）は
  `/** @type {any} */ (...)` で明示的に外す。「意図的な不正入力」だと読めるようにする

**完全な `.ts` 化は #6（パッケージング）と同時に行う方針。** electron-builder を入れる
時点でビルド工程が必要になるので、工程の導入を 2 回に分けない。それまでの穴はこの
型検査で埋める。

## プロジェクト構造

```
panedeck/
├── main.js              # メインプロセス（IPC ハンドラ）
├── preload.js           # contextBridge で API を Renderer に公開
├── index.html           # グリッド UI レイアウト・CSS
├── renderer.js          # ペイン管理・xterm 接続・ブロードキャスト
├── lib/
│   ├── session-manager.js   # pty セッションのレジストリ（コアロジック）
│   ├── status-detector.js   # 出力から状態を判定する純粋関数
│   └── workspace.js         # セッション構成の保存・復元
└── tests/
    ├── unit/            # lib/ のロジック単体テスト（Electron 不要）
    └── e2e/             # Playwright + Electron の E2E テスト
        ├── helpers/electron-app.js
        └── *.spec.js
```

### 設計方針

- **ロジックは lib/ に切り出し、Electron 非依存に保つ** — `main.js` から純粋に呼び出せる
  形にすることで、pty や BrowserWindow を起動せずに単体テストできる
- `SessionManager` は `ptyFactory` を **依存性注入** で受け取る。テストではフェイク pty を
  渡すため、実プロセスを起動せずに create/write/broadcast/close を検証できる
- `status-detector.js` は状態を持たない純粋関数のみ。入力（出力バッファ・経過時間）に対し
  出力（状態文字列）が一意に決まるので、エッジケースを網羅的にテストできる

## アーキテクチャ

- **セキュリティ**: `contextIsolation: true`, `nodeIntegration: false`
- **IPC 通信**: Main ↔ Preload ↔ Renderer の3層構造
- **IPC チャンネル**: `session:*`, `workspace:*`, `log:*`
- 戻り値が要るものは `invoke`/`handle`、キー入力など高頻度のものは `send`/`on`

## テスト規約

### 単体テスト (tests/unit/)

- `lib/` のモジュールを直接 require して検証する
- Electron も pty も起動しない。高速に回るのでここを厚くする
- フェイク pty は `tests/unit/helpers/fake-pty.js` を使う

### E2E テスト (tests/e2e/)

ライフサイクルパターン（全テスト共通）:

```js
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/electron-app");

let electronApp;
let page;

test.beforeAll(async () => {
  ({ electronApp, page } = await launchApp());
});

test.afterAll(async () => {
  await closeApp(electronApp);
});
```

- `beforeAll` / `afterAll` でアプリ起動・終了（スイート単位で1回）
- `beforeEach` は使わない（Electron アプリの起動コスト回避）
- 実シェルを起動するテストでは、OS 非依存にするため
  `node -e "..."` のような短命コマンドをセッションのシェルに指定する

### テスト設計の原則

1. **成功パスとキャンセル/失敗パスの両方をテストする**
2. **UI とメインプロセスの二重検証** - `page.locator()` + `electronApp.evaluate()`
3. **エッジケースを含める** - 空入力、特殊文字、境界値
4. **副作用のクリーンアップ** - `afterAll` で一時ファイル削除、セッション終了
5. **ファイル I/O は実ファイルでも検証** - `fs.existsSync` + `fs.readFileSync`

`page.waitForTimeout()` は原則使わない（`page.waitForFunction()` を使う）。

## Playwright 設定

- `workers: 1` - Electron シングルインスタンス制約
- `timeout: 30000` / `expect.timeout: 10000`
- `retries: 0` - リトライなし（テストは確定的であるべき）
- `projects: unit / e2e` - 単体テストと E2E を分離して個別実行できる
