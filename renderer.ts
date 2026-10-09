// ES モジュールとして読み込まれる（index.html の <script type="module">）。
// バンドラは挟まないので、相対 import には拡張子 .js を書くこと。
// xterm は npm の bare import が解決できないため、script タグで読み込んだ
// グローバル（Terminal / FitAddon）をそのまま使う。
import type {
  Session,
  SessionStatus,
  ServiceState,
  Settings,
  TriggerState,
} from "./types/panedeck";
import { STATUS_LABELS, KEY_SEQUENCES } from "./renderer/constants.js";
import { shouldCopySelection } from "./renderer/clipboard.js";
import { newlineSequenceFor } from "./renderer/keys.js";
import {
  targetIds,
  textOptions,
  optionsForKey,
  isInterruptKey,
  noTargetMessage,
  targetLabel,
} from "./renderer/broadcast.js";
import type { BroadcastPane } from "./renderer/broadcast.js";
import { serviceSummary, serviceLabel } from "./renderer/service-label.js";
import { closeAllPrompt } from "./renderer/close-all.js";

// contextBridge が公開したグローバル。モジュールなので、かつて衝突を招いた
// `const deck` という名前を避ける必要はもう無いが、呼び分けやすさで api のまま
const api = window.deck;

/**
 * 1 ペイン分の持ち物。
 *
 * `status` はメインプロセスから来た最新の状態の写し。送信先の件数表示に使う
 * （実際の絞り込みはメイン側で行うので、ここは表示専用）。
 */
interface Pane {
  id: string;
  el: HTMLElement;
  term: InstanceType<typeof Terminal>;
  fitAddon: InstanceType<(typeof FitAddon)["FitAddon"]>;
  statusEl: HTMLElement;
  triggerEl: HTMLElement;
  titleEl: HTMLElement;
  selectEl: HTMLInputElement;
  maximizeEl: HTMLElement;
  status: SessionStatus;
}

const grid = document.getElementById("grid")!;
const emptyState = document.getElementById("empty-state")!;
const sessionCountEl = document.getElementById("session-count")!;
const broadcastTargetEl = document.getElementById("broadcast-target")!;
const messageEl = document.getElementById("message")!;

// 値を読み書きする入力要素は具体的な型まで絞る
const broadcastInput = document.getElementById("broadcast-input") as HTMLInputElement;
const waitingOnlyEl = document.getElementById("waiting-only") as HTMLInputElement;
const launchCommandInput = document.getElementById(
  "launch-command"
) as HTMLInputElement;
const agentSelectEl = document.getElementById("agent-select") as HTMLSelectElement;
const fontSizeInput = document.getElementById("font-size") as HTMLInputElement;
const columnsSelectEl = document.getElementById("columns") as HTMLSelectElement;
const autoRestoreEl = document.getElementById("auto-restore") as HTMLInputElement;
const autoLogEl = document.getElementById("auto-log") as HTMLInputElement;
const logStripAnsiEl = document.getElementById("log-strip-ansi") as HTMLInputElement;
const logDirEl = document.getElementById("log-dir") as HTMLInputElement;
const logRetentionDaysEl = document.getElementById(
  "log-retention-days"
) as HTMLInputElement;
const logMaxTotalMbEl = document.getElementById(
  "log-max-total-mb"
) as HTMLInputElement;
const autoLogIndicatorEl = document.getElementById("auto-log-indicator")!;
const settingsBackdropEl = document.getElementById("settings-backdrop")!;
const triggerErrorEl = document.getElementById("trigger-error")!;
const triggerReleaseEl = document.getElementById("trigger-release") as HTMLButtonElement;
/** 上限で止まっているトリガー。解除のボタンが押されたらまとめて戻す */
let cappedWatches: string[] = [];
const serviceStatusEl = document.getElementById("service-status")!;
const serviceBackdropEl = document.getElementById("service-backdrop")!;
const serviceListEl = document.getElementById("service-list")!;
const serviceLogEl = document.getElementById("service-log")!;

/** セッション id → ペイン */
const panes = new Map<string, Pane>();

/** 裏のコマンドの様子（#29）。真実はメインプロセスが持つので突き合わせるだけ */
let services: ServiceState[] = [];
/** ログ窓で選ばれているサービス名。null なら未選択 */
let selectedService: string | null = null;

/**
 * createPane が進行中のセッション id。
 *
 * createPane は panes へ登録する前に log:get を await するため、その間に
 * 同期ポーリングが再入すると「まだ panes に無い」と判定して同じセッションの
 * ペインを二重に作る。先に作られた DOM は panes から参照されなくなり、
 * 状態も出力も届かず × でも閉じられない幽霊ペインとして残る。
 */
const creating = new Set<string>();

let focusedId: string | null = null;


/**
 * 端末の文字サイズ。メインプロセスの設定を写したもの。
 *
 * 新しく作るペインにも同じ値を渡す必要があるので、ここで保持する。
 * 正規化（範囲への丸め）はメイン側の lib/settings.js が持ち、ここは
 * 書き戻ってきた値を受け取るだけにする。規則を二重に持たない。
 */
let fontSize = 12;

/** 並べ替えでいま掴んでいるセッション id */
let draggingId: string | null = null;

/**
 * 全面に出しているセッション id。null なら通常のグリッド。
 *
 * 見え方だけの状態なので保存しない。送信先の決まり方にも影響させない
 * （拡大しただけで入力の行き先が変わると驚く）。
 */
let maximizedId: string | null = null;

/** グリッドの列数。拡大から戻すときに復元する */
let columns = 0;

/**
 * ツールバーに通知を出す。
 *
 * window.alert はネイティブモーダルを開いてしまい、E2E テストも実操作も
 * 止めてしまうため使わない。
 */
function showMessage(text: string, { error = false }: { error?: boolean } = {}) {
  messageEl.textContent = text;
  messageEl.classList.toggle("info", !error);
}

// ---------------------------------------------------------------- ペイン生成

async function createPane(session: Session): Promise<Pane> {
  const el = document.createElement("div");
  el.className = "pane";
  el.dataset.sessionId = session.id;
  el.dataset.testid = "pane";
  el.innerHTML = `
    <div class="pane-header">
      <input type="checkbox" class="pane-select" data-testid="pane-select" />
      <span class="pane-title" data-testid="pane-title"></span>
      <input
        class="pane-title-input"
        data-testid="pane-title-input"
        hidden
      />
      <span class="pane-cwd" data-testid="pane-cwd"></span>
      <span class="pane-command" data-testid="pane-command"></span>
      <span class="pane-trigger" data-testid="pane-trigger" hidden></span>
      <span class="pane-status" data-testid="pane-status"></span>
      <button class="pane-maximize" data-testid="pane-maximize">拡大</button>
      <button class="pane-savelog" data-testid="pane-savelog">ログ</button>
      <button class="pane-close danger" data-testid="pane-close">×</button>
    </div>
    <div class="pane-body"></div>
  `;

  const titleEl = el.querySelector(".pane-title") as HTMLElement;
  const titleInputEl = el.querySelector(".pane-title-input") as HTMLInputElement;
  const cwdEl = el.querySelector(".pane-cwd") as HTMLElement;
  const commandEl = el.querySelector(".pane-command") as HTMLElement;
  const statusEl = el.querySelector(".pane-status") as HTMLElement;
  const triggerEl = el.querySelector(".pane-trigger") as HTMLElement;
  const selectEl = el.querySelector(".pane-select") as HTMLInputElement;
  const maximizeEl = el.querySelector(".pane-maximize") as HTMLElement;
  const body = el.querySelector(".pane-body") as HTMLElement;

  titleEl.textContent = session.title;
  cwdEl.textContent = session.cwd || "";
  cwdEl.title = session.cwd || "";

  // どのペインがどのエージェントを走らせているか一目で分かるようにする
  commandEl.textContent = session.initialCommand || "";
  commandEl.title = session.initialCommand || "";

  const term = new Terminal({
    cursorBlink: true,
    fontSize,
    fontFamily: '"Cascadia Code", "Consolas", monospace',
    scrollback: 5000,
    theme: { background: "#010409", foreground: "#e6edf3" },
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  // 先に既存のログを流し込んでから map に登録する（重複表示を避けるため）
  const backlog = await api.getLog(session.id);

  grid.appendChild(el);
  term.open(body);
  if (backlog) term.write(backlog);

  const pane: Pane = {
    id: session.id,
    el,
    term,
    fitAddon,
    statusEl,
    triggerEl,
    titleEl,
    selectEl,
    maximizeEl,
    status: session.status,
  };
  panes.set(session.id, pane);

  fit(pane);

  // このペインへの直接入力（個別 sendkey）
  term.onData((data) => api.input(session.id, data));

  // 選択したうえでのコピー。これを挟まないと Ctrl+C は pty へ中断として
  // 送られ、Electron 既定メニューの Edit → Copy も効かない（あちらは DOM の
  // 選択範囲が対象で、xterm の選択は DOM の選択ではない）
  term.attachCustomKeyEventHandler((event) => {
    if (shouldCopySelection(event, term.hasSelection())) {
      copySelection(term);
      // xterm にもキーを渡さない（渡すと pty へ \x03 が飛ぶ）
      return false;
    }

    // 端末は Ctrl+Enter と Enter を区別せず、どちらも CR を送ってしまう。
    // 改行として通る別のバイト列に差し替える
    const newline = newlineSequenceFor(event);
    if (newline !== null) {
      // false を返すのは「xterm に処理させない」だけで、ブラウザ既定の動作は
      // 残る。Shift+Enter は隠しテキストエリアへ改行が入り、そこから CR が
      // 重ねて送られる（実測で 1b 0d 0d になった）
      event.preventDefault();
      api.input(session.id, newline);
      return false;
    }

    return true;
  });

  setupTitleEditing(session.id, titleEl, titleInputEl);

  el.addEventListener("mousedown", () => setFocused(session.id));
  selectEl.addEventListener("change", updateBroadcastTarget);

  el.querySelector(".pane-close")!.addEventListener("click", async (event) => {
    event.stopPropagation();
    await api.closeSession(session.id);
    await sync();
  });

  maximizeEl.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMaximize(session.id);
  });

  el.querySelector(".pane-savelog")!.addEventListener("click", async (event) => {
    event.stopPropagation();
    await api.saveLog(session.id);
  });

  setupDragAndDrop(el, session.id);

  new ResizeObserver(() => fit(pane)).observe(body);

  return pane;
}

/**
 * ヘッダを掴んでペインを並べ替える。
 *
 * 掴む場所をヘッダに限るのは、端末の上でドラッグを始めると文字の選択が
 * できなくなるため。
 */
function setupDragAndDrop(el: HTMLElement, id: string) {
  const header = el.querySelector(".pane-header") as HTMLElement;
  header.draggable = true;

  header.addEventListener("dragstart", (event) => {
    draggingId = id;
    el.classList.add("dragging");
    event.dataTransfer!.effectAllowed = "move";
    // 一部の環境ではデータを載せないとドラッグが始まらない
    event.dataTransfer!.setData("text/plain", id);
  });

  header.addEventListener("dragend", () => {
    draggingId = null;
    el.classList.remove("dragging");
    clearDropMarks();
  });

  el.addEventListener("dragover", (event) => {
    if (!draggingId || draggingId === id) return;
    event.preventDefault();
    event.dataTransfer!.dropEffect = "move";

    // 掴んでいるものを、このペインの前に置くか後ろに置くか
    const rect = el.getBoundingClientRect();
    const before = event.clientX < rect.left + rect.width / 2;
    clearDropMarks();
    el.classList.toggle("drop-before", before);
    el.classList.toggle("drop-after", !before);
  });

  el.addEventListener("drop", async (event) => {
    if (!draggingId || draggingId === id) return;
    event.preventDefault();

    const before = el.classList.contains("drop-before");
    const moved = draggingId;
    draggingId = null;
    clearDropMarks();

    await moveSession(moved, id, before);
  });
}

function clearDropMarks() {
  panes.forEach((pane) => {
    pane.el.classList.remove("drop-before", "drop-after");
  });
}

/** 画面に並んでいる順のセッション id */
function currentOrder(): string[] {
  return [...grid.querySelectorAll<HTMLElement>(".pane")].map(
    (el) => el.dataset.sessionId!
  );
}

/**
 * 1 つのペインを別のペインの前後へ移す。
 *
 * 並び順の持ち主はメインプロセスなので、ここでは新しい順を組み立てて渡すだけ。
 * DOM を先に動かすと、次の同期でメイン側の順に戻されてちらつく。
 */
async function moveSession(movedId: string, targetId: string, before: boolean) {
  if (!movedId || movedId === targetId) return;

  const order = currentOrder().filter((id) => id !== movedId);
  const at = order.indexOf(targetId);
  if (at === -1) return;

  order.splice(before ? at : at + 1, 0, movedId);

  await api.reorderSessions(order);
  await sync();
}

/**
 * 端末の選択範囲をクリップボードへ写す。
 *
 * 写した後は選択を解除する。残したままだと次に Ctrl+C を押しても
 * またコピーになり、実行中のコマンドを止められない。
 */
async function copySelection(term: InstanceType<typeof Terminal>) {
  // 空行を選んだときは hasSelection() が true でも中身が無い。何もしない
  const text = term.getSelection();
  if (text === "") return;

  const result = await api.writeClipboard(text);
  if (!result.ok) {
    showMessage(`コピーできません: ${result.error}`, { error: true });
    return;
  }

  term.clearSelection();
  showMessage(`${text.length} 文字コピーしました`);
}

function removePane(id: string) {
  const pane = panes.get(id);
  if (!pane) return;
  cancelPtyResize(id);
  pane.term.dispose();
  pane.el.remove();
  panes.delete(id);
  if (focusedId === id) focusedId = null;

  // 拡大していたペインが閉じたら通常表示へ戻す。
  // 残したままだと、隠れたペインだけの何も見えない画面になる
  if (maximizedId === id) {
    maximizedId = null;
    applyMaximize();
  }
}

// -------------------------------------------------------------- ペインの拡大

/**
 * 1 ペインだけを全面に出す / 戻す。
 *
 * グリッドを畳んで他を隠すだけで、ペインも端末も作り直さない。pty との接続も
 * スクロールバックもそのまま残る。
 */
function toggleMaximize(id: string) {
  maximizedId = maximizedId === id ? null : id;
  applyMaximize();
}

function applyMaximize() {
  const on = maximizedId !== null;

  grid.classList.toggle("maximized", on);
  panes.forEach((pane, paneId) => {
    const isMax = paneId === maximizedId;
    pane.el.classList.toggle("maximized", isMax);
    pane.maximizeEl.textContent = isMax ? "戻す" : "拡大";
  });

  // 拡大中は 1 列。戻すときに設定してあった列数へ返す
  grid.style.gridTemplateColumns =
    !on && columns > 0 ? `repeat(${columns}, minmax(0, 1fr))` : "";

  // 大きさが変わるので測り直す
  panes.forEach(fit);
}

/**
 * pty へのリサイズ要求をまとめる。
 *
 * ペインを作った直後はレイアウトが 2 段階で確定するため 80x24 → 79x24 →
 * 実寸と要求が続けて飛ぶ。node-pty の resize はメインプロセスの上で同期的に
 * 走るので、ConPTY が返さなければアプリ全体が固まる（#16）。呼ぶ回数は
 * 減らしておくに越したことがない。
 *
 * 画面側の見た目は fit() がすぐ合わせる。ここで遅らせるのは pty へ伝える
 * ぶんだけなので、体感は変わらない。
 */
const RESIZE_QUIET_MS = 150;
const resizeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function requestPtyResize(pane: Pane) {
  const pending = resizeTimers.get(pane.id);
  if (pending !== undefined) clearTimeout(pending);

  resizeTimers.set(
    pane.id,
    setTimeout(() => {
      resizeTimers.delete(pane.id);
      // 待っている間に閉じられたペインには送らない
      if (!panes.has(pane.id)) return;
      api.resize(pane.id, pane.term.cols, pane.term.rows);
    }, RESIZE_QUIET_MS)
  );
}

/** 保留中のリサイズ要求を取り消す。 */
function cancelPtyResize(id: string) {
  const pending = resizeTimers.get(id);
  if (pending === undefined) return;
  clearTimeout(pending);
  resizeTimers.delete(id);
}

/**
 * ペインの大きさに端末を合わせる。
 *
 * **大きさが変わらないときは何もしない。** ここは ResizeObserver から呼ばれる
 * ので、毎回 fit すると「fit → DOM の寸法が変わる → ResizeObserver → fit」で
 * 回り続ける。出力が増えてスクロールバーが出入りすると幅が二値の間で振動し、
 * 収束しない。実際、実 pty のペインを作るとレンダラが応答を返さなくなっていた。
 */
function fit(pane: Pane) {
  // 隠れているペインは測れない。測ると 0 桁になり、その値で pty を
  // リサイズしてしまう
  if (pane.el.offsetParent === null) return;

  try {
    const next = pane.fitAddon.proposeDimensions();
    if (!next || !Number.isFinite(next.cols) || !Number.isFinite(next.rows)) return;
    if (next.cols === pane.term.cols && next.rows === pane.term.rows) return;

    // 画面はすぐ合わせる。pty へ伝えるのは落ち着いてから
    pane.fitAddon.fit();
    requestPtyResize(pane);
  } catch {
    // レイアウト確定前は測れないことがあるので無視する
  }
}

/**
 * 題を二度押しで書き換えられるようにする（#28）。
 *
 * トリガーの送り先は題で指すので、既定（作業ディレクトリの末尾）のままだと
 * 同じディレクトリの 2 枚を区別できない。
 *
 * ヘッダはすでに窮屈なのでボタンは足さず、二度押しで入れ替える。確定は
 * Enter と焦点外れ、取り消しは Escape。**window.prompt は使わない** ——
 * ネイティブのモーダルは E2E も実操作も止める。
 */
function setupTitleEditing(
  id: string,
  titleEl: HTMLElement,
  inputEl: HTMLInputElement
) {
  const open = () => {
    inputEl.value = titleEl.textContent ?? "";
    inputEl.hidden = false;
    titleEl.hidden = true;
    inputEl.focus();
    inputEl.select();
  };

  const close = () => {
    inputEl.hidden = true;
    titleEl.hidden = false;
  };

  const commit = async () => {
    if (inputEl.hidden) return;
    const next = inputEl.value;
    close();
    await api.renameSession(id, next);
    // 表示は同期の突き合わせに任せる。ここで書くと真実が 2 箇所になる
    await sync();
  };

  titleEl.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    open();
  });

  inputEl.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });

  // 焦点が外れたら確定。開いたまま迷子にしない
  inputEl.addEventListener("blur", () => void commit());
  inputEl.addEventListener("mousedown", (event) => event.stopPropagation());
}

function setFocused(id: string) {
  focusedId = id;
  panes.forEach((pane, paneId) => {
    pane.el.classList.toggle("focused", paneId === id);
  });
  panes.get(id)?.term.focus();
}

// ------------------------------------------------------------------ 同期処理

/**
 * メインプロセスのセッション一覧と画面上のペインを突き合わせる。
 *
 * ペイン生成をこの一箇所に集約することで、UI からの追加でも
 * ワークスペース復元でも同じ経路でペインが並ぶ。
 */
/**
 * トリガーの様子をペインと画面に出す（#28）。
 *
 * **黙って何もしないトリガーこそ、この機能が取り除きたい失敗。** 届け先が
 * 無い・ファイルが読めないは、送れていないと分かるところに出す。
 */
function applyTriggers(states: TriggerState[]) {
  for (const pane of panes.values()) {
    const mine = states.filter((state) => state.title === pane.titleEl.textContent);
    const held = mine.reduce((sum, state) => sum + state.held, 0);

    pane.triggerEl.hidden = mine.length === 0;
    pane.triggerEl.textContent = held > 0 ? `保留 ${held}` : "監視中";
    pane.triggerEl.classList.toggle("held", held > 0);
  }

  const errors = states.filter((state) => state.error !== "");
  triggerErrorEl.textContent = errors.map((state) => state.error).join(" / ");
  triggerErrorEl.hidden = errors.length === 0;

  // **自動では戻さない。** 止めたことが見え、人が押して初めて再開する（#34 の ③）
  cappedWatches = states.filter((state) => state.capped).map((state) => state.watch);
  triggerReleaseEl.hidden = cappedWatches.length === 0;
}

/**
 * 裏のコマンドの様子をツールバーに出す（#29）。
 *
 * **出力はペインへ流さない。** ここで見るだけ。流していたら、受け取ってから
 * 伝えるまでに止まった行が失われる（間にファイルを挟む理由がそれ）。
 */
function applyServices(states: ServiceState[]) {
  services = states;

  const summary = serviceSummary(states);
  serviceStatusEl.hidden = summary === null;
  if (summary) {
    serviceStatusEl.textContent = summary.text;
    serviceStatusEl.classList.toggle("failing", summary.failing);
  }

  // 開いている間は中身も追いかける（落ちた瞬間を見ていられるように）
  if (!serviceBackdropEl.hidden) renderServiceList();
}

function renderServiceList() {
  serviceListEl.textContent = "";

  for (const state of services) {
    const button = document.createElement("button");
    button.textContent = serviceLabel(state);
    button.dataset.service = state.name;
    button.classList.toggle("selected", state.name === selectedService);
    button.addEventListener("click", () => selectService(state.name));
    serviceListEl.append(button);
  }
}

async function selectService(name: string) {
  selectedService = name;
  renderServiceList();

  const log = await api.getServiceLog(name);
  serviceLogEl.textContent = log === "" ? "（まだ出力がありません）" : log;
  // 新しいほうを見たいので末尾へ寄せる
  serviceLogEl.scrollTop = serviceLogEl.scrollHeight;
}

async function sync() {
  const sessions = await api.listSessions();
  const alive = new Set(sessions.map((s) => s.id));

  for (const id of [...panes.keys()]) {
    if (!alive.has(id)) removePane(id);
  }

  for (const session of sessions) {
    const pane = panes.get(session.id);
    if (!pane) {
      if (creating.has(session.id)) continue;
      creating.add(session.id);
      try {
        await createPane(session);
      } finally {
        creating.delete(session.id);
      }
    } else {
      pane.titleEl.textContent = session.title;
      pane.status = session.status;
      pane.statusEl.textContent = STATUS_LABELS[session.status] ?? session.status;
      pane.statusEl.dataset.status = session.status;
    }
  }

  applyOrder(sessions);
  // 拡大中に増えたペインにも状態を行き渡らせる（隠す・ボタンの表示）
  if (maximizedId !== null) applyMaximize();

  const count = sessions.length;
  sessionCountEl.textContent = `${count} セッション`;
  grid.classList.toggle("empty", count === 0);
  emptyState.style.display = count === 0 ? "" : "none";
  updateBroadcastTarget();
  applyTriggers(await api.listTriggers());
  applyServices(await api.listServices());
}

/**
 * 画面上のペインをメインプロセスの並び順に合わせる。
 *
 * 既にある DOM を動かすだけで、ペインも端末も作り直さない（pty との接続が
 * 切れない）。並びが同じときは何もしない。同期は 300ms ごとに走るので、
 * 毎回動かすと端末の描画が飛び続ける。
 */
function applyOrder(sessions: Session[]) {
  const desired = sessions
    .map((session) => panes.get(session.id)?.el)
    .filter(Boolean) as HTMLElement[];
  const current = [...grid.querySelectorAll(".pane")];

  const same =
    desired.length === current.length &&
    desired.every((el, i) => el === current[i]);
  if (same) return;

  for (const el of desired) grid.appendChild(el);

  // 付け替えで端末の描画が飛ぶことがあるので測り直す
  panes.forEach(fit);
}

/**
 * 送信先の判断に渡す形へ写す。
 *
 * ここから先（誰に届くか・何と表示するか）は `renderer/broadcast.ts` の
 * 純粋関数が決める。DOM を読むのはこの 1 箇所だけにしておく。
 */
function broadcastPanes(): BroadcastPane[] {
  return [...panes.values()].map((pane) => ({
    id: pane.id,
    status: pane.status,
    selected: pane.selectEl.checked,
  }));
}

function updateBroadcastTarget() {
  broadcastTargetEl.textContent = targetLabel(
    broadcastPanes(),
    waitingOnlyEl.checked
  );
}

// -------------------------------------------------------------------- 操作

/**
 * エージェント選択を組み立てる。
 *
 * 判定に使う正規表現はメインプロセス側にあり、ここへは id / 表示名 / 既定コマンド
 * だけが来る。選ぶと起動コマンド欄をそのエージェントの既定で置き換えるが、
 * 手で書き換えた値はそのまま使われる（コマンドと判定は独立して指定できる）。
 */
async function setupAgentSelect() {
  const profiles = await api.listAgents();

  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    option.dataset.command = profile.command;
    agentSelectEl.appendChild(option);
  }

  agentSelectEl.addEventListener("change", () => {
    const selected = agentSelectEl.selectedOptions[0];
    if (selected) launchCommandInput.value = selected.dataset.command ?? "";
  });
}

// ------------------------------------------------------------------ 設定

/**
 * 文字サイズを全ペインへ適用する。
 *
 * 変更後は fit() を通す。桁数・行数が変わるので、pty 側にも既存の resize 経路で
 * 伝わる（伝えないと出力の折り返しがずれる）。
 */
function applyFontSize(size: number) {
  fontSize = size;
  fontSizeInput.value = String(size);

  panes.forEach((pane) => {
    pane.term.options.fontSize = size;
    fit(pane);
  });
}

/**
 * グリッドの列数を反映する。
 *
 * 0 は「幅に合わせて自動で折り返す」で、その場合は CSS の既定に戻す。
 */
function applyColumns(next: number) {
  columns = next;
  columnsSelectEl.value = String(next);

  // 拡大中は 1 列のままにする。戻したときに applyMaximize が復元する
  if (maximizedId === null) {
    grid.style.gridTemplateColumns =
      next > 0 ? `repeat(${next}, minmax(0, 1fr))` : "";
  }

  panes.forEach(fit);
}

/**
 * 設定を画面へ行き渡らせる。
 *
 * 保存の戻り値と読み込みの両方がここを通るので、**画面に出る値は必ず
 * メイン側が正規化した後のもの**になる。丸めの規則をレンダラが持たない。
 */
function applySettings(settings: Settings) {
  applyFontSize(settings.fontSize);
  applyColumns(settings.columns);

  autoRestoreEl.checked = settings.autoRestore;
  autoLogEl.checked = settings.autoLog;
  logStripAnsiEl.checked = settings.logStripAnsi;
  logDirEl.value = settings.logDir;
  logRetentionDaysEl.value = String(settings.logRetentionDays);
  logMaxTotalMbEl.value = String(settings.logMaxTotalMB);

  // 設定へ隠した分、書き続けていることはツールバーで示す
  autoLogIndicatorEl.hidden = !settings.autoLog;
}

/** 変更した項目だけを保存し、返ってきた値で画面を揃える。 */
async function commitSetting(patch: Partial<Settings>) {
  const result = await api.setSettings(patch);
  if (!result.ok) {
    showMessage(`設定を保存できません: ${result.error}`, { error: true });
    // 保存できていない値を画面に残さない
    await loadSettings();
    return;
  }

  applySettings(result.settings);
}

/**
 * 数値の入力欄を保存する。
 *
 * 空欄や数値でない入力は「まだ入力途中」とみなして何もしない。打っている最中に
 * 勝手に既定へ戻ると打ち直しになるため。範囲への丸めはメイン側が行う。
 */
async function commitNumber(input: HTMLInputElement, key: keyof Settings) {
  const raw = input.value.trim();
  if (raw === "" || !Number.isFinite(Number(raw))) {
    await loadSettings();
    return;
  }

  await commitSetting({ [key]: Number(raw) });
}

/** 保存済みの設定を読み込んで画面へ反映する。 */
async function loadSettings() {
  applySettings(await api.getSettings());
}

// ------------------------------------------------------- 設定ダイアログ

function openSettings() {
  settingsBackdropEl.hidden = false;
}

function closeSettings() {
  settingsBackdropEl.hidden = true;
}

/** ログの出力先を選ぶ。空に戻すと既定の場所（userData 配下）に戻る。 */
async function pickLogDir() {
  const dir = await api.pickDirectory();
  if (!dir) return;

  await commitSetting({ logDir: dir });
}

async function addSession() {
  const cwd = await api.pickDirectory();
  if (!cwd) return;

  const result = await api.createSession({
    cwd,
    initialCommand: launchCommandInput.value.trim(),
    agent: agentSelectEl.value,
  });
  if (!result.ok) {
    showMessage(`セッションを起動できません: ${result.error}`, { error: true });
    return;
  }
  showMessage("");
  await sync();
  setFocused(result.session.id);
}

async function sendBroadcast() {
  const text = broadcastInput.value;
  if (text === "") return;

  const waitingOnly = waitingOnlyEl.checked;
  const sent = await api.broadcast(
    `${text}\r`,
    targetIds(broadcastPanes()),
    // テキストは指示待ちだけ。確認待ちへ送ると打った文字が回答になる（#27）
    textOptions(waitingOnly)
  );
  if (sent === 0) {
    // 打ち直さずに済むよう入力は残す
    showMessage(noTargetMessage(waitingOnly), { error: true });
    return;
  }

  showMessage("");
  broadcastInput.value = "";
}

/**
 * 特殊キーを送る。
 *
 * 中断のキー（Esc / Ctrl+C）だけは「入力待ちのみ」を無視する。止めたいのは
 * 動いているペインで、入力待ちのペインは定義上なにも実行していないため、
 * 絞り込んだままだと一番使いたい瞬間に空振りする（#25）。
 *
 * ただし画面の表示（送信先: 入力待ち N ペイン）とは食い違うことになるので、
 * **何ペインへ届いたかを必ず知らせる。** 黙って別の相手に送るほうが悪い。
 */
async function sendKey(key: string) {
  const sequence = KEY_SEQUENCES[key];
  if (!sequence) return;

  const waitingOnly = waitingOnlyEl.checked;
  const interrupt = isInterruptKey(key);
  const sent = await api.broadcast(
    sequence,
    targetIds(broadcastPanes()),
    optionsForKey(key, waitingOnly)
  );
  if (sent === 0) {
    // 中断は絞り込みを外しているので、0 件なら理由は「入力待ちが無い」ではない
    showMessage(interrupt ? "送信先のペインがありません" : noTargetMessage(waitingOnly), {
      error: true,
    });
    return;
  }

  showMessage(interrupt ? `中断を ${sent} ペインへ送りました` : "");
}

// ---------------------------------------------------------------- イベント

document.getElementById("add-session")!.addEventListener("click", addSession);

document.getElementById("broadcast-send")!.addEventListener("click", sendBroadcast);

triggerReleaseEl.addEventListener("click", async () => {
  for (const watch of cappedWatches) await api.releaseTrigger(watch);
  triggerReleaseEl.hidden = true;
});

broadcastInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") sendBroadcast();
});

waitingOnlyEl.addEventListener("change", updateBroadcastTarget);

// --- 裏のコマンドのログ窓（#29） ---

serviceStatusEl.addEventListener("click", () => {
  serviceBackdropEl.hidden = false;
  renderServiceList();
  // 何も選ばれていなければ先頭を開く（押してから更に選ばせない）
  if (services.length > 0) void selectService(selectedService ?? services[0].name);
});

document.getElementById("service-close")!.addEventListener("click", () => {
  serviceBackdropEl.hidden = true;
});

serviceBackdropEl.addEventListener("click", (event) => {
  if (event.target === serviceBackdropEl) serviceBackdropEl.hidden = true;
});

// --- 設定ダイアログ ---

document.getElementById("open-settings")!.addEventListener("click", openSettings);
document.getElementById("close-settings")!.addEventListener("click", closeSettings);

// 背景のクリックで閉じる。中身のクリックは拾わない
settingsBackdropEl.addEventListener("click", (event) => {
  if (event.target === settingsBackdropEl) closeSettings();
});

// Esc で閉じる。**開いているときだけ**拾う。端末では Esc は pty へ送る
// 必要があり、常時横取りすると実行中の処理を中断できなくなる
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!settingsBackdropEl.hidden) closeSettings();
  else if (!serviceBackdropEl.hidden) serviceBackdropEl.hidden = true;
});

fontSizeInput.addEventListener("change", () =>
  commitNumber(fontSizeInput, "fontSize")
);
logRetentionDaysEl.addEventListener("change", () =>
  commitNumber(logRetentionDaysEl, "logRetentionDays")
);
logMaxTotalMbEl.addEventListener("change", () =>
  commitNumber(logMaxTotalMbEl, "logMaxTotalMB")
);

columnsSelectEl.addEventListener("change", () =>
  commitSetting({ columns: Number(columnsSelectEl.value) })
);
autoRestoreEl.addEventListener("change", () =>
  commitSetting({ autoRestore: autoRestoreEl.checked })
);
autoLogEl.addEventListener("change", () =>
  commitSetting({ autoLog: autoLogEl.checked })
);
logStripAnsiEl.addEventListener("change", () =>
  commitSetting({ logStripAnsi: logStripAnsiEl.checked })
);

document.getElementById("pick-log-dir")!.addEventListener("click", pickLogDir);
document
  .getElementById("clear-log-dir")!
  .addEventListener("click", () => commitSetting({ logDir: "" }));

const keyButtons = document.querySelectorAll<HTMLElement>("#keys button");
keyButtons.forEach((button) => {
  button.addEventListener("click", () => sendKey(button.dataset.key!));
});

const closeAllBackdropEl = document.getElementById("close-all-backdrop")!;
const closeAllCancelEl = document.getElementById("close-all-cancel") as HTMLButtonElement;

function closeCloseAllConfirm() {
  closeAllBackdropEl.hidden = true;
}

/**
 * 全終了は**押しただけでは閉じない**（2026-10-09）。何が止まるかを数で出し、
 * もう一度押させる。状態はメインから取り直す —— 画面の状態は最大 300ms 古い
 */
document.getElementById("close-all")!.addEventListener("click", async () => {
  const sessions = await api.listSessions();
  const prompt = closeAllPrompt(sessions.map((session) => session.status));
  if (!prompt) return;
  document.getElementById("close-all-text")!.textContent = prompt.text;
  closeAllBackdropEl.hidden = false;
  // ★ 最初に選ぶのは「やめる」。Enter の押し間違いで終了しない
  closeAllCancelEl.focus();
});

document.getElementById("close-all-ok")!.addEventListener("click", async () => {
  closeCloseAllConfirm();
  await api.closeAllSessions();
  await sync();
  await showRestorePrevious();
});

const restorePreviousEl = document.getElementById("restore-previous") as HTMLButtonElement;

/**
 * 全終了の直前の構成が残っていれば、空の画面に戻すボタンを出す（2026-10-09）。
 * 300ms の突き合わせでは聞かない。全終了の後と起動時だけで足りる
 */
async function showRestorePrevious() {
  const count = await api.countPrevious();
  restorePreviousEl.textContent = `直前の構成に戻す（${count} 個）`;
  restorePreviousEl.hidden = count === 0;
}

restorePreviousEl.addEventListener("click", async () => {
  restorePreviousEl.hidden = true;
  const result = await api.restorePrevious();
  if (!result.ok) showMessage(`戻せません: ${result.error}`, { error: true });
  await sync();
});

closeAllCancelEl.addEventListener("click", closeCloseAllConfirm);

// 背景を押しても、Esc でも閉じる。どちらも「やめる」側
closeAllBackdropEl.addEventListener("click", (event) => {
  if (event.target === closeAllBackdropEl) closeCloseAllConfirm();
});
closeAllBackdropEl.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeCloseAllConfirm();
});

document.getElementById("save-workspace")!.addEventListener("click", async () => {
  const result = await api.saveWorkspace("panedeck");
  if (result.ok) {
    showMessage(`構成を保存しました: ${result.filePath}`);
  } else if (result.error) {
    showMessage(`保存できません: ${result.error}`, { error: true });
  }
});

document
  .getElementById("restore-workspace")!
  .addEventListener("click", async () => {
    const result = await api.restoreWorkspace();
    if (result.ok === false && result.error) {
      showMessage(`復元できません: ${result.error}`, { error: true });
    } else if (result.ok) {
      showMessage(`「${result.name}」を復元しました`);
    }
    await sync();
  });

api.onSessionData((id, data) => {
  panes.get(id)?.term.write(data);
});

api.onSessionExit((id) => {
  panes.get(id)?.term.write("\r\n\x1b[31m[プロセスが終了しました]\x1b[0m\r\n");
});

// 書き込みに失敗したセッションはメイン側が記録を諦めるので、通知は一度きり
api.onLogError(({ filePath, error }) => {
  showMessage(`ログを保存できません (${filePath}): ${error}`, { error: true });
});

window.addEventListener("resize", () => panes.forEach(fit));

// メインプロセス側で増減したセッションにも追従する
setInterval(sync, 300);
setupAgentSelect();
loadSettings();
sync();
// 前回の起動で全終了したまま閉じていれば、空の画面に戻すボタンが出る
showRestorePrevious();
