# PaneDeck - CLAUDE.md

## プロジェクト概要

複数のコーディングエージェント（Claude Code / Codex など）のセッションを
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
npm start          # ビルドしてアプリ起動
npm run build      # TypeScript を dist/ へコンパイル
npm test           # 型検査 + ビルド + 全テスト（unit + e2e）
npm run typecheck  # 型検査のみ（tsc --noEmit）
npm run test:unit  # ロジック単体テストのみ（高速）
npm run test:e2e   # Electron E2E テストのみ
npm run test:report  # HTML レポート表示
npm run rebuild    # node-pty を Electron ABI 向けに再ビルド
```

## TypeScript

ソースもテストも全て `.ts`。ビルド出力は `dist/` で、`package.json` の `main` は
`dist/main.js` を指す。**`dist/` はコミットしない。**

### 3 つの tsconfig

| ファイル | 役割 |
|---|---|
| `tsconfig.json` | 型検査のみ（`noEmit`）。renderer もテストも含めて全体を見る |
| `tsconfig.build.json` | main / preload / lib を `dist/` へ出す |
| `tsconfig.renderer.json` | renderer を `dist/` へ出す |

renderer を分けているのは出力の性質が違うため。**ブラウザがそのまま読む ES モジュール**
として出す（バンドラは挟まない）。index.html は `<script type="module">` で読み、
CSP は `script-src 'self'` のまま。

- **相対 import には拡張子 `.js` を書くこと。** バンドラが居ないので、ブラウザが
  そのまま解決する。`./renderer/constants.js` のように書く（`.ts` ではない）
- **npm の bare import は解決できない。** xterm は今までどおり script タグで読み、
  グローバル（`Terminal` / `FitAddon`）を使う。宣言は `types/globals.d.ts`
- レンダラ側の分割ファイルは `renderer/` に置く

以前は古典スクリプトだった。TS 化の移行リスクを抑えるため読み込み方を据え置いた
名残で、その間は**トップレベルの名前がすべてグローバルと競合**していた
（HANDOVER にある `const deck` の事故がこれ）。モジュール化でこの危険は消えた。

### 型の置き場

- 層をまたぐ受け渡しの形は `types/panedeck.d.ts` に 1 つだけ。`Session` に項目を
  足すときはここを直せば、main / preload / renderer / workspace のどこで漏らしても
  検査で落ちる
- `types/globals.d.ts` は `window.deck`、xterm のグローバル、E2E が仕込む
  `global.__sessionManager` などの宣言
- `preload.ts` は `DeckApi` として型を付ける。チャンネル名やペイロードを変えたとき、
  preload と呼び出し側のどちらかだけ直し忘れると検査で落ちる

### 厳格さ

`strictNullChecks` は **有効**。`strict` / `noImplicitAny` はまだ off で、
これらを上げるのは今後の作業。

`createSession` / `setSettings` の戻り値は**判別可能な union**。`if (!result.ok)` で
絞り込めるので、成功時にしか無い項目へ誤って触ると検査で落ちる。

テストが**わざと不正な値を渡す**箇所（`onlyStatus: "nonsense"` など）は `as any` で
明示的に外す。「意図的な不正入力」だと読めるようにするため。

### E2E はレンダラの内部に触らない

以前は `page.evaluate(() => panes...)` でレンダラのトップレベル変数を覗いていた。
古典スクリプトだから届いていただけで、モジュール化すると壊れる。

いまは DOM から観測する。文字サイズは `.pane .xterm-rows` の計算済みスタイル、
セッションとペインの対応は `.pane[data-session-id]`。**表示された結果を見るほうが
テストとして素直**でもある。

### 移行で踏んだ落とし穴

`status-detector.ts` の `ANSI_PATTERN` には**生の ESC バイトが直接埋まっていた**。
ソース上で不可視なので書き写しで消え、`[Y/n]` を ANSI と誤認して削るようになった。
制御文字は必ず `\x1b` のような escape で書くこと。

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
│   ├── agent-profiles.js    # エージェント定義（表示名/起動コマンド/待機パターン）
│   ├── command.js           # 起動コマンドの正規化
│   ├── settings.js          # アプリ設定の読み書き（保存先パスは注入）
│   ├── log-writer.js        # 出力のバッファリングとファイル追記
│   ├── log-retention.js     # 古いログの片付け（索引で自作分だけを対象に）
│   └── workspace.js         # セッション構成の保存・復元
├── types/
│   ├── panedeck.d.ts        # 層をまたぐ受け渡しの形（Session / DeckApi など）
│   └── globals.d.ts         # window.deck・xterm グローバル・E2E の足場
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
