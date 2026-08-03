// contextBridge が公開したグローバル `deck` と同名で const 宣言すると
// "Identifier 'deck' has already been declared" でスクリプト全体が落ちるため、別名にする
// ES モジュールとして読み込まれる（index.html の <script type="module">）。
// バンドラは挟まないので、相対 import には拡張子 .js を書くこと。
// xterm は npm の bare import が解決できないため、script タグで読み込んだ
// グローバル（Terminal / FitAddon）をそのまま使う。
import type { Session, SessionStatus } from "./types/panedeck";
import { STATUS_LABELS, WAITING, KEY_SEQUENCES } from "./renderer/constants.js";

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
  titleEl: HTMLElement;
  selectEl: HTMLInputElement;
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

/** セッション id → ペイン */
const panes = new Map<string, Pane>();

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
      <span class="pane-cwd" data-testid="pane-cwd"></span>
      <span class="pane-command" data-testid="pane-command"></span>
      <span class="pane-status" data-testid="pane-status"></span>
      <button class="pane-savelog" data-testid="pane-savelog">ログ</button>
      <button class="pane-close danger" data-testid="pane-close">×</button>
    </div>
    <div class="pane-body"></div>
  `;

  const titleEl = el.querySelector(".pane-title") as HTMLElement;
  const cwdEl = el.querySelector(".pane-cwd") as HTMLElement;
  const commandEl = el.querySelector(".pane-command") as HTMLElement;
  const statusEl = el.querySelector(".pane-status") as HTMLElement;
  const selectEl = el.querySelector(".pane-select") as HTMLInputElement;
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
    titleEl,
    selectEl,
    status: session.status,
  };
  panes.set(session.id, pane);

  fit(pane);

  // このペインへの直接入力（個別 sendkey）
  term.onData((data) => api.input(session.id, data));

  el.addEventListener("mousedown", () => setFocused(session.id));
  selectEl.addEventListener("change", updateBroadcastTarget);

  el.querySelector(".pane-close")!.addEventListener("click", async (event) => {
    event.stopPropagation();
    await api.closeSession(session.id);
    await sync();
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

function removePane(id: string) {
  const pane = panes.get(id);
  if (!pane) return;
  pane.term.dispose();
  pane.el.remove();
  panes.delete(id);
  if (focusedId === id) focusedId = null;
}

function fit(pane: Pane) {
  try {
    pane.fitAddon.fit();
    api.resize(pane.id, pane.term.cols, pane.term.rows);
  } catch {
    // レイアウト確定前は fit が失敗することがあるので無視する
  }
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

  const count = sessions.length;
  sessionCountEl.textContent = `${count} セッション`;
  grid.classList.toggle("empty", count === 0);
  emptyState.style.display = count === 0 ? "" : "none";
  updateBroadcastTarget();
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

function selectedPanes() {
  return [...panes.values()].filter((pane) => pane.selectEl.checked);
}

function selectedIds() {
  return selectedPanes().map((pane) => pane.id);
}

/** 送信対象。チェックが無ければ全ペイン。 */
function targetIds() {
  const selected = selectedIds();
  return selected.length > 0 ? selected : null;
}

/**
 * 状態による絞り込み。
 *
 * 絞り込み自体はメインプロセスに委ねる。レンダラが持つ状態は 300ms ポーリング
 * ぶん古くなりうるので、送信可否はその場で状態を算出できる側で決める。
 */
function broadcastOptions() {
  return waitingOnlyEl.checked ? { onlyStatus: WAITING } : undefined;
}

/** 送信先が 0 件だったときの説明。 */
function noTargetMessage() {
  return waitingOnlyEl.checked
    ? "入力待ちのペインがありません"
    : "送信先のペインがありません";
}

function updateBroadcastTarget() {
  const selected = selectedPanes();
  const scoped = selected.length > 0;
  const targets = scoped ? selected : [...panes.values()];

  if (!waitingOnlyEl.checked) {
    broadcastTargetEl.textContent = scoped
      ? `送信先: 選択 ${targets.length} ペイン`
      : `送信先: 全 ${targets.length} ペイン`;
    return;
  }

  const count = targets.filter((pane) => pane.status === WAITING).length;
  broadcastTargetEl.textContent = scoped
    ? `送信先: 選択のうち入力待ち ${count} ペイン`
    : `送信先: 入力待ち ${count} ペイン`;
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
 *
 * @param {number} size
 */
function applyFontSize(size) {
  fontSize = size;
  fontSizeInput.value = String(size);

  panes.forEach((pane) => {
    pane.term.options.fontSize = size;
    fit(pane);
  });
}

/**
 * 入力欄の変更を設定へ反映する。
 *
 * 空欄や数値でない入力は「まだ入力途中」とみなして何もしない。打っている最中に
 * 勝手に既定へ戻ると打ち直しになるため。範囲への丸めはメイン側が行い、
 * 返ってきた値で入力欄を上書きする。
 */
async function commitFontSize() {
  const raw = fontSizeInput.value.trim();
  if (raw === "" || !Number.isFinite(Number(raw))) {
    fontSizeInput.value = String(fontSize);
    return;
  }

  const result = await api.setSettings({ fontSize: Number(raw) });
  if (!result.ok) {
    showMessage(`設定を保存できません: ${result.error}`, { error: true });
    fontSizeInput.value = String(fontSize);
    return;
  }

  applyFontSize(result.settings.fontSize);
}

/**
 * 自動復元の ON / OFF を保存する。
 *
 * 復元されるかどうかを決めるだけで、構成の記録は止めない。記録まで止めると
 * 有効に戻したときに復元するものが残っていない。
 */
async function commitAutoRestore() {
  const result = await api.setSettings({ autoRestore: autoRestoreEl.checked });
  if (!result.ok) {
    showMessage(`設定を保存できません: ${result.error}`, { error: true });
    // 保存できていない状態を有効に見せない
    autoRestoreEl.checked = !autoRestoreEl.checked;
    return;
  }

  autoRestoreEl.checked = result.settings.autoRestore;
}

/**
 * ログの自動保存の ON / OFF を保存する。
 *
 * 既に開いているセッションの分も含めて、メインプロセス側が書き出しを
 * 開始・停止する。
 */
async function commitAutoLog() {
  const result = await api.setSettings({ autoLog: autoLogEl.checked });
  if (!result.ok) {
    showMessage(`設定を保存できません: ${result.error}`, { error: true });
    autoLogEl.checked = !autoLogEl.checked;
    return;
  }

  autoLogEl.checked = result.settings.autoLog;
  // 出力先は設定ファイルでしか変えられないので、有効にしたときに示す
  showMessage(
    autoLogEl.checked ? "ログの自動保存を開始しました" : "ログの自動保存を止めました"
  );
}

/**
 * グリッドの列数を反映する。
 *
 * 0 は「幅に合わせて自動で折り返す」で、その場合は CSS の既定に戻す。
 *
 * @param {number} columns
 */
function applyColumns(columns) {
  columnsSelectEl.value = String(columns);
  grid.style.gridTemplateColumns =
    columns > 0 ? `repeat(${columns}, minmax(0, 1fr))` : "";

  panes.forEach(fit);
}

async function commitColumns() {
  const result = await api.setSettings({ columns: Number(columnsSelectEl.value) });
  if (!result.ok) {
    showMessage(`設定を保存できません: ${result.error}`, { error: true });
    return;
  }

  applyColumns(result.settings.columns);
}

/** 起動時に保存済みの設定を読み込む。 */
async function loadSettings() {
  const settings = await api.getSettings();
  applyFontSize(settings.fontSize);
  applyColumns(settings.columns);
  autoRestoreEl.checked = settings.autoRestore;
  autoLogEl.checked = settings.autoLog;
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

  const sent = await api.broadcast(`${text}\r`, targetIds(), broadcastOptions());
  if (sent === 0) {
    // 打ち直さずに済むよう入力は残す
    showMessage(noTargetMessage(), { error: true });
    return;
  }

  showMessage("");
  broadcastInput.value = "";
}

async function sendKey(key) {
  const sequence = KEY_SEQUENCES[key];
  if (!sequence) return;

  const sent = await api.broadcast(sequence, targetIds(), broadcastOptions());
  if (sent === 0) {
    showMessage(noTargetMessage(), { error: true });
    return;
  }

  showMessage("");
}

// ---------------------------------------------------------------- イベント

document.getElementById("add-session")!.addEventListener("click", addSession);

document.getElementById("broadcast-send")!.addEventListener("click", sendBroadcast);

broadcastInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") sendBroadcast();
});

waitingOnlyEl.addEventListener("change", updateBroadcastTarget);

fontSizeInput.addEventListener("change", commitFontSize);

autoRestoreEl.addEventListener("change", commitAutoRestore);

autoLogEl.addEventListener("change", commitAutoLog);

columnsSelectEl.addEventListener("change", commitColumns);

const keyButtons = document.querySelectorAll<HTMLElement>("#keys button");
keyButtons.forEach((button) => {
  button.addEventListener("click", () => sendKey(button.dataset.key!));
});

document.getElementById("close-all")!.addEventListener("click", async () => {
  await api.closeAllSessions();
  await sync();
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
    const result = await api.restoreWorkspace({
      initialCommand: launchCommandInput.value.trim(),
      agent: agentSelectEl.value,
    });
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
