# PaneDeck

[![Tests](https://github.com/gamasenninn/panedeck/actions/workflows/test.yml/badge.svg)](https://github.com/gamasenninn/panedeck/actions/workflows/test.yml)

[日本語版 README](README.ja.md)

An Electron terminal app for running several coding-agent sessions side by side in a grid of panes, and driving them together.

## What it is

Running a coding agent per repository means cycling through terminal tabs to find out which one has stopped and is waiting for you. PaneDeck puts every session on one screen, shows what each is doing as a badge, and lets one instruction go to several of them at once.

It launches whatever command you give it, so any agent with a CLI can sit in a pane. Waiting-detection patterns ship for Claude Code and Codex.

![Four panes running side by side. Two stop at a confirmation prompt and their badges turn to "waiting"; one Enter goes to those two alone and both carry on; one pane is then maximised and dropped back into the grid.](docs/demo.gif)

Recorded by `npm run demo`. The sessions are fakes from the test harness — real agents would put local paths and whatever happens to be in progress on screen, and would look different every take. The output fed to them does match the real detection patterns, so the badges are the detector's own verdict rather than a mock-up.

**The interface is in Japanese.** The code and this document are not, but the buttons and labels you will see are. See [known limitations](#known-limitations).

## Requirements

- Node.js 24 (what development and CI run on; older versions are untested)
- Electron 40.x
- **Windows.** macOS and Linux are untested — see below

Nothing in the code is deliberately Windows-only: node-pty and xterm.js are cross-platform, and the default shell is chosen per platform. But the app has only ever been run on Windows, and the pty layer is exactly where platforms diverge. The one bug that froze the entire app ([#16](https://github.com/gamasenninn/panedeck/issues/16)) was a ConPTY deadlock and could not have appeared anywhere else. Treat other platforms as unknown rather than broken.

## Setup

```bash
cd panedeck
npm install
npm start        # compiles TypeScript, then launches Electron
```

`node-pty` ships N-API prebuilds, so **rebuilding is normally unnecessary** — N-API keeps its ABI stable across Node and Electron. Run `npm run rebuild` only if you land on an environment where the module fails to load.

## Packaging

```bash
npm run icon     # build/icon.svg -> build/icon.png (only when the icon changes)
npm run pack     # unpacked build in release/win-unpacked/ (no installer)
npm run dist     # installer and portable build in release/
```

On Windows this produces an NSIS installer (`PaneDeck Setup <version>.exe`) and a portable build (`PaneDeck <version>.exe`). Configuration lives in `electron-builder.yml`.

One `build/icon.png` at 1024x1024 is enough; electron-builder derives `.ico` and `.icns` from it. The source of truth is `build/icon.svg`, and `scripts/make-icon.mjs` renders the PNG.

### Packaging notes

- **`npmRebuild: false`.** The point is to use node-pty's prebuilds as they are. Rebuilding from source fails in node-gyp because winpty's `GetCommitHash.bat` is missing.
- **node-pty is listed under `asarUnpack`.** It carries the ConPTY helper executable, and executables inside an asar archive cannot be launched.

### Verifying the build

```bash
npm run test:packaged   # packs, then launches the result and checks it
```

This covers the failures that only exist in a packaged app: files unreadable inside the asar, native modules that will not load, ESM resolution that breaks. None of those paths are exercised by the development tests, which is why they are a separate suite.

## Features

### A grid of terminals

Every pane owns an independent pty process and is drawn by xterm.js. Clicking a pane moves focus, and keystrokes reach that session alone.

The column count is set in settings (auto, or 1 to 6). Auto wraps to fit the width.

### Maximising one pane

**拡大** ("maximise") in a pane header brings that pane to full view; **戻す** ("restore") returns to the grid.

This only collapses the grid and hides the others, so **the terminal is never rebuilt** — the pty connection and the scrollback survive. Columns and rows are re-measured to match the new size.

It is presentation only and is not persisted. It also **does not change where broadcasts go**: having a pane grow should not quietly redirect your input. Closing a maximised pane drops back to the grid on its own.

### Reordering panes

Drag a pane by its header. The order lives in the main process and is reproduced when a layout is saved and restored. Terminals are not rebuilt, so neither the connection nor the scrollback is lost.

### Agent profiles

Switching agent in the toolbar changes the launch command **and the waiting-detection patterns** together. The launch command can still be edited by hand afterwards — which binary to start and which patterns to judge it by are separate choices.

Claude Code, Codex and a plain shell ship with the app. Patterns for both agents were taken from real session logs and verified against them. **Only what has been verified gets added**; no guessed regular expressions, because a false positive is worse than a miss.

Gemini CLI was included once and then removed. Detection worked, but Japanese input never reached it (PaneDeck was confirmed to be sending correct UTF-8, so the problem was on the receiving side) and the CLI appeared to have stopped being maintained. Old layouts containing `agent: "gemini"` still load and fall back to Claude Code.

### Adding a session

**+ セッション追加** ("add session") asks for a directory, starts a shell with it as the working directory, and feeds in whatever is in the launch command field. Leave that empty for a bare shell. The launch command is remembered per session and shown in the pane header.

### Broadcast

What you type in the bar at the bottom goes to several panes at once.

- With **no** pane checkboxes ticked it goes to every pane; with some ticked, only to those
- **入力待ちのみ** ("waiting only") narrows it to panes that are stopped waiting for input. Combined with checkboxes, both conditions apply
- The filtering happens in the main process against the state at send time — what the renderer displays can be up to 300ms stale
- If nothing matches, nothing is sent and the input is not cleared

### Special keys

| Button | Sequence | Use |
|---|---|---|
| Enter | `\r` | Answer a confirmation prompt |
| Esc | `\x1b` | Interrupt what is running |
| Ctrl+C | `\x03` | Interrupt the process |
| ↑ / ↓ | `\x1b[A` / `\x1b[B` | Move through choices, recall history |

Targets are chosen the same way as broadcasts — "send Enter, but only to the panes that are stopped" is what this is for — with one deliberate exception.

**Esc and Ctrl+C ignore "waiting only".** They exist to stop a pane that is busy, and a pane waiting for input is by definition not busy, so honouring the filter would send the interrupt to every pane except the ones that need it. Since the filter is natural to leave switched on, that would fail exactly when it matters. Pane selection still applies: ticking panes is a deliberate choice, whereas waiting-only is a mode. Because this diverges from what the target line says, an interrupt always reports how many panes it reached.

### Newlines in an agent's input box

To insert a line break rather than submitting:

| Key | What is sent |
|---|---|
| `Ctrl+Enter` / `Shift+Enter` | `ESC CR`, which is treated as a newline |
| `Alt+Enter` | The same (what xterm sends natively) |
| `Ctrl+J` | `LF` |
| `Enter` | `CR` — submits, as always |

Terminals traditionally do not distinguish `Ctrl+Enter` from `Enter`: **both send `CR`**, identical bytes to whatever is reading, so both mean submit. Telling them apart needs an extension such as `modifyOtherKeys` or the Kitty keyboard protocol. PaneDeck implements no extension and substitutes `ESC CR`, which passes as a newline.

Unmodified `Enter` is left alone — taking it would leave you unable to submit anything. The toolbar's **Enter** button also still submits; its job is to move a stopped pane along.

### Copy

Select text in a terminal, then:

| Key | Behaviour |
|---|---|
| `Ctrl+Shift+C` | Copy the selection |
| `Ctrl+Insert` | The same |
| `Ctrl+C` **with a selection** | Copy. No interrupt reaches the pty |
| `Ctrl+C` with no selection | Interrupt (`\x03`), as always |

Copying clears the selection. Without that, the next `Ctrl+C` would copy as well, leaving no way to stop a running command.

xterm passes input straight through to the pty, so untouched, `Ctrl+C` is an interrupt and nothing else. Electron's built-in Edit → Copy does not help either: it works on the DOM selection, and an xterm selection is not one.

### Status

| Badge | Meaning | Rule |
|---|---|---|
| 実行中 (running) | Something is happening | Output within the last 400ms |
| 入力待ち (waiting) | **You need to do something** | Output stopped and the tail matches the profile's waiting patterns |
| 待機 (idle) | Nothing is running | Output stopped, no pattern matched |
| 終了 (exited) | The process ended | The pty reported an exit |

Detection is a pure function in `lib/status-detector.ts` and looks at the last 10 lines only.

### Settings

The gear button in the toolbar opens a dialog: font size (8 to 32), column count, restore on start, log auto-save, log directory, ANSI stripping, retention days and total size cap. Everything there is persisted and survives a restart.

### Output logs

- The **ログ** ("log") button in a pane header writes that session's entire output to a file
- **Log auto-save** appends to a per-session file as output arrives

Files go under `logs/` in userData by default; the directory is configurable. ANSI escapes are stripped by default.

### Cleaning up old logs

On startup, logs past the retention period and the oldest files above the total size cap are deleted.

| Setting | Default | Meaning |
|---|---|---|
| Retention days | 30 | `0` disables expiry by age |
| Total size cap (MB) | 500 | `0` disables expiry by size |

Setting both to `0` effectively turns cleanup off.

**PaneDeck never deletes a file it did not create.** An index, `.panedeck-logs.json`, is kept alongside the logs, and **only files recorded there** are candidates for deletion. Matching on filename patterns could catch somebody else's file that happens to sit in the same directory, so the record of "I wrote this" is the authority instead. If the index cannot be read, nothing is deleted.

### Saving and restoring a layout

**構成を保存** ("save layout") writes each session's `title`, `cwd`, `shell`, `args`, launch command and agent to JSON, in the order shown. Session ids and runtime state are not saved.

With **restore on start** enabled, the layout is captured whenever sessions are added or removed, and comes back on the next launch.

Restoring reproduces what was saved. The toolbar's launch command and agent are not mixed in, so a pane saved without a launch command comes back as a plain shell — it used to be filled in from the toolbar, which meant panes meant as shells started an agent instead.

## Project layout

```
panedeck/
├── main.ts              # main process (IPC handlers)
├── preload.ts           # exposes the API to the renderer via contextBridge
├── index.html           # grid layout and CSS
├── renderer.ts          # panes, xterm wiring, broadcast
├── renderer/            # renderer-side modules
├── lib/                 # logic with no Electron dependency
│   ├── session-manager.ts   # registry of pty sessions (the core)
│   ├── status-detector.ts   # pure functions deciding state from output
│   ├── agent-profiles.ts    # agent definitions
│   ├── command.ts           # launch command normalisation
│   ├── settings.ts          # reading and writing settings
│   ├── log-writer.ts        # buffering output and appending to files
│   └── workspace.ts         # saving and restoring layouts
├── types/               # types shared across layers
├── build/               # icon (svg is the source, png is generated)
├── scripts/             # build helpers
└── tests/
    ├── unit/            # logic tests for lib/ (no Electron)
    ├── e2e/             # Playwright + Electron
    └── packaged/        # launches the packaged build and checks it
```

Build output goes to `dist/`, which is not committed.

### Design

Logic lives in `lib/` and depends on neither Electron nor node-pty.

- `SessionManager` takes its pty factory by **dependency injection**. Tests pass a fake, so nothing is verified by starting real processes
- `status-detector.ts` holds no state — pure functions only
- The clock is injected too, so state transitions are tested deterministically rather than against wall time
- Paths for settings and logs are injected as well, so tests never touch a real user's data

## Architecture

```
┌─────────────────────────────────────────────┐
│  Main process (main.ts)                     │
│  SessionManager -> node-pty x N             │
│  LogWriter / Settings / Workspace           │
│         ▲                                   │
│         │ ipcMain.handle() / ipcMain.on()   │
└─────────┼───────────────────────────────────┘
          │ IPC
┌─────────┼───────────────────────────────────┐
│  Preload (preload.ts)                       │
│  contextBridge -> window.deck  (DeckApi)    │
└─────────┼───────────────────────────────────┘
          │
┌─────────┼───────────────────────────────────┐
│  Renderer (renderer.ts + index.html)        │
│  xterm.js x N arranged in a grid            │
└─────────────────────────────────────────────┘
```

- `contextIsolation: true`, `nodeIntegration: false`
- CSP set through a `<meta>` tag (`script-src 'self'`)
- Operations that return something use `invoke`/`handle`; keystrokes and resizes are frequent enough to use `send`/`on`
- The renderer is loaded as ES modules. There is no bundler, so relative imports carry a `.js` extension

The renderer reconciles its panes against the main process's session list every 300ms. **Both the order and the state belong to the main process**, so polling can never roll the display back.

### IPC channels

| Channel | Direction | Method | Purpose |
|---|---|---|---|
| `session:create` | R → M | invoke/handle | Create a session |
| `session:list` | R → M | invoke/handle | List sessions, with state |
| `session:close` | R → M | invoke/handle | Close one |
| `session:closeAll` | R → M | invoke/handle | Close all |
| `session:reorder` | R → M | invoke/handle | Change the order |
| `session:broadcast` | R → M | invoke/handle | Broadcast, optionally filtered by state |
| `session:pickDirectory` | R → M | invoke/handle | Directory picker |
| `clipboard:write` | R → M | invoke/handle | Copy a selection |
| `session:input` | R → M | send/on | Forward keystrokes to the pty |
| `session:resize` | R → M | send/on | Sync terminal size |
| `session:data` | M → R | send/on | pty output to the renderer |
| `session:exit` | M → R | send/on | Process exit |
| `agent:list` | R → M | invoke/handle | Agent profiles |
| `settings:get` / `settings:set` | R → M | invoke/handle | Settings |
| `log:get` | R → M | invoke/handle | Accumulated log |
| `log:save` | R → M | invoke/handle | Write a log to a file |
| `log:error` | M → R | send/on | A log write failed |
| `workspace:save` | R → M | invoke/handle | Save a layout |
| `workspace:restore` | R → M | invoke/handle | Restore a layout and start everything |

## Tests

Development is test-first.

```bash
npm test              # typecheck + build + unit + e2e
npm run typecheck
npm run test:unit     # logic only — fast, no Electron
npm run test:e2e
npm run test:headed   # e2e with the window on screen, to watch it work
npm run test:packaged
npm run test:report
npm run demo          # re-record the GIF at the top of this file
```

`npm run demo` drives the app through `tests/demo/record.spec.ts`, records it, and writes `docs/demo.gif`. Nothing extra needs installing: Playwright's own ffmpeg splits the video into frames, and sharp — already here for icon generation — assembles the GIF. That ffmpeg is a minimal build with no gif encoder and almost no filters, which is worth knowing before trying to do the whole conversion with it.

The e2e windows do not appear on screen. Electron has no true headless mode like Chromium's, so **the window is placed off-screen** rather than hidden.

`show: false` also keeps it out of sight, but Chromium then stops producing frames and every Playwright stability check waits. Measured: one suite went from 9 seconds to 59, and the full run from 2.3 minutes to 11.6. Backgrounding switches made no difference. Off-screen keeps compositing alive, so nothing is paid for the privacy.

E2E swaps `global.__sessionManager.ptyFactory` for a fake, so almost nothing needs real processes, and the clock can be replaced so state-transition tests do not depend on wall time. Only `real-pty.spec.ts` and the auto-restore tests start real ones.

## Known limitations

- **The interface is in Japanese.** Buttons, labels and status badges are not translated
- Only Windows is verified. See [requirements](#requirements)
- Status detection is a heuristic. For agents beyond the bundled profiles, nothing but confirmation prompts such as `(y/n)` will be recognised
- Adding an agent profile means editing `lib/agent-profiles.ts`; there is no UI for it
- Log cleanup only considers files in its index. Change the output directory and the logs in the old one stop being cleaned — it fails towards keeping files, so the damage is small
- Some auto-save failures are not reported. The automatic layout capture gives up silently

## License

[MIT](LICENSE) — Copyright (c) 2026 Satoshi Ono

The main things bundled are MIT as well: [Electron](https://github.com/electron/electron), [node-pty](https://github.com/microsoft/node-pty) and [xterm.js](https://github.com/xtermjs/xterm.js).
