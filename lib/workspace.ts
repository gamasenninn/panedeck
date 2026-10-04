import fs from "fs";
import path from "path";

import type { Session, Workspace, WorkspaceEntry } from "../types/panedeck";
import { normalizeCommand } from "./command";

/** ワークスペースファイルの形式バージョン */
export const WORKSPACE_VERSION = 1;

const DEFAULT_NAME = "workspace";

/**
 * 復元に必要な項目だけを取り出した 1 セッション分のエントリを作る。
 *
 * 起動コマンドは値があるときだけ載せる。項目の有無で「起動コマンドを持たない
 * 既存ファイル」と「明示的に空」を区別しないことで、読み手はどちらも
 * 「未指定」として同じ経路で扱える。
 */
function toEntry(source: Partial<WorkspaceEntry>): WorkspaceEntry {
  const entry: WorkspaceEntry = {
    title: source.title,
    cwd: source.cwd!,
    shell: source.shell,
    args: Array.isArray(source.args) ? source.args : [],
  };

  const initialCommand = normalizeCommand(source.initialCommand);
  if (initialCommand) entry.initialCommand = initialCommand;

  // エージェントプロファイルも同じ扱い（値があるときだけ載せる）。
  // 実在する id かどうかは復元側の resolveProfile が引き受ける
  if (typeof source.agent === "string" && source.agent !== "") {
    entry.agent = source.agent;
  }

  // 会話の id（#33）。**ペインと組で持つ** —— 題は重なり、ペインの id は
  // 起動ごとに振り直されるので、どちらも会話を指す鍵にならない。
  // 値があるときだけ載せるのは起動コマンドと同じ扱い
  if (typeof source.sessionId === "string" && source.sessionId !== "") {
    entry.sessionId = source.sessionId;
  }

  // 再開しない印（#33）。受付のような常駐は新しい会話で足りる
  if (source.noResume === true) entry.noResume = true;

  return entry;
}

/**
 * 実行中のセッション一覧を、復元に必要な情報だけの形に落とす。
 *
 * id や status といった実行時の情報は保存しない（次回は別の id で起動するため）。
 * 並び順は配列の順そのもの。位置を表す項目は持たせない。
 */
export function serializeWorkspace(
  sessions: Array<Partial<Session>>,
  { name }: { name?: string } = {}
): Workspace {
  return {
    version: WORKSPACE_VERSION,
    name: name || DEFAULT_NAME,
    sessions: (sessions ?? []).map(toEntry),
  };
}

/**
 * ワークスペース JSON を読み、復元に使える形に正規化する。
 *
 * 壊れたエントリ（cwd 無し）は捨て、未知のフィールドは持ち込まない。
 *
 * @throws JSON が壊れている / 形式が違う / バージョンが新しすぎる場合
 */
export function parseWorkspace(text: string): Workspace {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`ワークスペースの JSON を解析できません: ${(err as Error).message}`);
  }

  if (!raw || typeof raw !== "object") {
    throw new Error("ワークスペースの形式が不正です");
  }

  if (Number(raw.version) > WORKSPACE_VERSION) {
    throw new Error(
      `ワークスペースのバージョン ${raw.version} はこのアプリ (${WORKSPACE_VERSION}) より新しいため読み込めません`
    );
  }

  if (!Array.isArray(raw.sessions)) {
    throw new Error("ワークスペースに sessions 配列がありません");
  }

  return {
    version: Number(raw.version) || WORKSPACE_VERSION,
    name: raw.name || DEFAULT_NAME,
    sessions: raw.sessions
      .filter((s: any) => s && typeof s.cwd === "string" && s.cwd !== "")
      .map((s: any) =>
        toEntry({
          ...s,
          // 文字列以外の起動コマンドは持ち込まない（そのまま pty へ流さない）
          initialCommand:
            typeof s.initialCommand === "string" ? s.initialCommand : undefined,
        })
      ),
  };
}

/** ワークスペースをファイルに保存する（親ディレクトリが無ければ作る）。 */
export function saveWorkspace(
  filePath: string,
  sessions: Array<Partial<Session>>,
  options: { name?: string } = {}
): Workspace {
  const workspace = serializeWorkspace(sessions, options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(workspace, null, 2), "utf8");
  return workspace;
}

/**
 * ワークスペースファイルを読み込む。
 * @throws ファイルが無い / 形式が不正な場合
 */
export function loadWorkspace(filePath: string): Workspace {
  return parseWorkspace(fs.readFileSync(filePath, "utf8"));
}

/**
 * ワークスペースファイルを読む。読めなければ null を返す。
 *
 * 自動復元用。無い・壊れている・形が違う・バージョンが新しすぎる、のいずれでも
 * 例外にしない。初回起動では必ず「無い」を通るし、保存ファイル 1 つで
 * アプリが起動できなくなるのを避けたい。
 *
 * ユーザーが明示的にファイルを選ぶ復元は `loadWorkspace` のまま。あちらは
 * 選んだファイルが読めなかったことを伝える必要がある。
 */
export function tryLoadWorkspace(filePath: string): Workspace | null {
  try {
    return loadWorkspace(filePath);
  } catch {
    return null;
  }
}
