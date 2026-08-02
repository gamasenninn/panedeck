# ClaudeDeck

複数の Claude Code セッションをグリッド分割ペインで同時に走らせ、まとめて操作するための Electron ターミナルアプリ。

## これは何か

リポジトリごとに Claude Code を立ち上げて並行作業していると、ターミナルのタブを行ったり来たりして「どれが入力待ちで止まっているか」が分からなくなる。ClaudeDeck は全セッションを 1 画面に並べ、状態をバッジで示し、同じ指示をまとめて送れるようにする。

```
┌─────────────┬─────────────┐
│ repo-a  実行中 │ repo-b 入力待ち │
│ $ claude    │ $ claude    │
├─────────────┼─────────────┤
│ repo-c  待機   │ repo-d   終了  │
│ $ claude    │ $ claude    │
└─────────────┴─────────────┘
[ 送信先: 全 4 ペイン ][ ______________ ][送信] [Enter][Esc][Ctrl+C][↑][↓]
```

## 動作環境

- Node.js v18+
- Electron v40.x
- Windows / macOS / Linux（シェルは OS 既定を使用）

## セットアップ

```bash
cd claudedeck
npm install
npm run rebuild   # node-pty を Electron の ABI 向けに再ビルド（初回必須）
npm start
```

`npm run rebuild` を飛ばすと、ネイティブモジュールの ABI 不一致で起動時に node-pty の読み込みに失敗する。

## 機能

### 複数ターミナルのグリッド表示

ペインは幅に応じて自動で折り返す（`auto-fit` グリッド）。各ペインは独立した pty プロセスを持ち、xterm.js で描画される。ペインをクリックするとフォーカスが移り、キー入力はそのセッションにだけ届く。

### セッションの追加

ツールバーの **+ セッション追加** でディレクトリを選ぶと、そこを cwd としてシェルが起動し、**起動コマンド** 欄の内容（既定 `claude`）が流し込まれる。起動コマンドを空にすれば素のシェルが開く。

### 一斉入力（Broadcast）

下部の入力欄に打った内容を、複数ペインへまとめて送る。

- ペインのチェックボックスが**どれも未選択なら全ペイン**が対象
- チェックしたペインがあれば**そのペインだけ**が対象
- 送信先は「送信先: 全 4 ペイン」のように常に表示される

### 特殊キーの送信

対話 UI の Claude Code では、テキストだけでなくキー単体を送りたい場面が多い。

| ボタン | 送信されるシーケンス | 用途 |
|---|---|---|
| Enter | `\r` | 確認プロンプトの決定 |
| Esc | `\x1b` | 実行中の処理を中断 |
| Ctrl+C | `\x03` | プロセスに割り込み |
| ↑ / ↓ | `\x1b[A` / `\x1b[B` | 選択肢の移動、履歴呼び出し |

送信先の決まり方は一斉入力と同じなので、1 ペインだけチェックすれば個別 sendkey になる。

### 状態の可視化

各ペインのヘッダに状態バッジを表示する。判定は出力内容と「最後の出力からの経過時間」から行う。

| バッジ | 意味 | 判定条件 |
|---|---|---|
| 実行中 | 処理が動いている | 直近 400ms 以内に出力がある |
| 入力待ち | **ユーザーの操作が必要** | 出力が止まり、末尾に Claude の入力ボックス `│ >`、選択肢 `❯`、`(y/n)`、`Press Enter` などがある |
| 待機 | 何も走っていない | 出力が止まり、入力待ちパターンに当てはまらない |
| 終了 | プロセスが終了した | pty の exit を受信 |

判定は `lib/status-detector.js` のヒューリスティックで、末尾 10 行だけを見る。

### 出力ログの保存

ペインの **ログ** ボタンで、そのセッションの全出力をファイルに保存する。ログはメインプロセス側にセッションごとに蓄積され、既定で末尾 500,000 文字を保持する（超えた分は古い方から捨てる）。

### セッション構成の保存・復元

**構成を保存** で、現在並んでいるセッションの `title` / `cwd` / `shell` / `args` を JSON に書き出す。id や実行状態は保存しない。

**構成を復元** でその JSON を読み込むと、同じディレクトリ構成でセッションが一括起動し、起動コマンドがそれぞれに流し込まれる。「朝の巡回セット」のような作業単位をワンクリックで再現できる。

## プロジェクト構造

```
claudedeck/
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
```

### 設計方針

ロジックを `lib/` に切り出し、Electron にも node-pty にも依存させていない。

- `SessionManager` は pty の生成関数を**依存性注入**で受け取る。テストではフェイクを渡すので、実プロセスを起動せずに create / write / broadcast / close を検証できる
- `status-detector.js` は状態を持たない純粋関数のみ。入力に対して出力が一意に決まるため、エッジケースを網羅的にテストできる
- 時刻取得も注入されるので、状態遷移（実行中 → 待機）を実時間に頼らず決定的にテストできる

## アーキテクチャ

```
┌─────────────────────────────────────────────┐
│  Main Process (main.js)                     │
│  SessionManager → node-pty × N              │
│         ▲                                   │
│         │ ipcMain.handle() / ipcMain.on()   │
└─────────┼───────────────────────────────────┘
          │ IPC
┌─────────┼───────────────────────────────────┐
│  Preload (preload.js)                       │
│  contextBridge → window.deck                │
└─────────┼───────────────────────────────────┘
          │
┌─────────┼───────────────────────────────────┐
│  Renderer (renderer.js + index.html)        │
│  xterm.js × N をグリッドに配置               │
└─────────────────────────────────────────────┘
```

- `contextIsolation: true` / `nodeIntegration: false`
- CSP を `<meta>` タグで設定
- 戻り値が要る操作は `invoke` / `handle`、キー入力とリサイズは高頻度なので `send` / `on`

レンダラはメインプロセスのセッション一覧を 300ms ごとに突き合わせてペインを増減させる。ペイン生成経路が 1 箇所に集約されるので、UI からの追加でもワークスペース復元でも同じ流れでペインが並ぶ。

### IPC チャンネル一覧

| チャンネル名 | 方向 | メソッド | 説明 |
|---|---|---|---|
| `session:create` | R → M | invoke/handle | セッション生成 |
| `session:list` | R → M | invoke/handle | セッション一覧（状態込み） |
| `session:close` | R → M | invoke/handle | 個別終了 |
| `session:closeAll` | R → M | invoke/handle | 全終了 |
| `session:broadcast` | R → M | invoke/handle | 一斉入力 |
| `session:pickDirectory` | R → M | invoke/handle | ディレクトリ選択ダイアログ |
| `session:input` | R → M | send/on | キー入力を pty へ転送 |
| `session:resize` | R → M | send/on | ターミナルサイズ同期 |
| `session:data` | M → R | send/on | pty 出力をレンダラへ |
| `session:exit` | M → R | send/on | プロセス終了通知 |
| `log:get` | R → M | invoke/handle | 蓄積ログ取得 |
| `log:save` | R → M | invoke/handle | ログをファイルに保存 |
| `workspace:save` | R → M | invoke/handle | 構成を保存 |
| `workspace:restore` | R → M | invoke/handle | 構成を復元して一括起動 |

## テスト

TDD で開発している。ロジックの単体テストと Electron の E2E テストを Playwright の projects で分けている。

```bash
npm test           # 全テスト
npm run test:unit  # ロジック単体テストのみ（高速、Electron 不要）
npm run test:e2e   # Electron E2E テストのみ
npm run test:report
```

E2E は `global.__sessionManager.ptyFactory` をフェイクに差し替えて実プロセス無しで検証する。時計も差し替えられるので、状態遷移のテストが実時間に左右されない。`real-pty.spec.js` だけはフェイクを使わず、短命なコマンドを実際に起動して pty 連携そのものを確認する。

## 既知の制限

- 状態判定はヒューリスティック。Claude Code の UI が変われば `lib/status-detector.js` のパターン追加が必要になる
- 一斉入力は文字列をそのまま各 pty に書き込む。各セッションの状態は考慮しないので、入力待ちでないペインにも届く
- ログはメモリ上のリングバッファ。アプリを閉じると失われる（保存は明示操作）
