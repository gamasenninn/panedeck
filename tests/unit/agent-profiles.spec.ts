import { test, expect } from "@playwright/test";
import {
  AGENT_PROFILES,
  DEFAULT_AGENT_ID,
  listProfiles,
  resolveProfile,
} from "../../lib/agent-profiles";
import {
  WAITING_PATTERNS,
  detectStatus,
  STATUS,
  QUIET_MS,
} from "../../lib/status-detector";

test.describe("プロファイル定義", () => {
  test("既定は Claude Code（現行動作の維持）", () => {
    expect(DEFAULT_AGENT_ID).toBe("claude");
    expect(resolveProfile(DEFAULT_AGENT_ID).id).toBe("claude");
  });

  test("claude の待機パターンは従来の既定と同じ集合", () => {
    // ここがずれると「改名前と判定が変わった」ことになる
    const claude = resolveProfile("claude").waitingPatterns.map(String);
    expect(new Set(claude)).toEqual(new Set(WAITING_PATTERNS.map(String)));
  });

  test("どのプロファイルも id / name / command / waitingPatterns を持つ", () => {
    for (const profile of AGENT_PROFILES) {
      expect(typeof profile.id).toBe("string");
      expect(profile.id).not.toBe("");
      expect(typeof profile.name).toBe("string");
      expect(typeof profile.command).toBe("string");
      expect(Array.isArray(profile.waitingPatterns)).toBe(true);
      expect(profile.waitingPatterns.every((p) => p instanceof RegExp)).toBe(true);
    }
  });

  test("id が重複していない", () => {
    const ids = AGENT_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("同梱するのは claude / codex / shell", () => {
    // Gemini CLI は外した。実機で試したところ日本語入力が通らず、
    // CLI 自体が更新の対象から外れているように見えたため
    expect(AGENT_PROFILES.map((p) => p.id)).toEqual(["claude", "codex", "shell"]);
  });

  test("外した gemini を指しても落ちず既定になる（古い構成の後方互換）", () => {
    // ワークスペースや自動復元の控えに agent: "gemini" が残っていても、
    // 読み込みで例外にはしない。Claude Code のパターンで判定される
    expect(resolveProfile("gemini").id).toBe(DEFAULT_AGENT_ID);
  });

  test("行頭の選択マーカー › を拾う（codex の選択肢で使われる）", () => {
    // 実機の codex は ❯ ではなく › を使っていた。行頭に限るのは、
    // 文章中の › を選択肢と誤認しないため
    const menu = ["› 1. Update now", "  2. Skip"].join("\n");

    for (const profile of AGENT_PROFILES) {
      if (profile.id === "claude") continue;
      expect(profile.waitingPatterns.some((p) => p.test(menu))).toBe(true);
    }
  });

  test("文章の途中の › は選択肢とみなさない", () => {
    const prose = "設定は File › Preferences から開ける";

    for (const profile of AGENT_PROFILES) {
      expect(profile.waitingPatterns.some((p) => p.test(prose))).toBe(false);
    }
  });

  test("確認プロンプトはどのプロファイルでも入力待ちになる", () => {
    // エージェントを問わず出る形。ここを取りこぼすと主機能が働かない
    for (const profile of AGENT_PROFILES) {
      expect(profile.waitingPatterns.some((p) => p.test("Continue? (y/n)"))).toBe(
        true
      );
    }
  });
});

test.describe("listProfiles", () => {
  test("id / name / command だけを返す", () => {
    for (const entry of listProfiles()) {
      expect(Object.keys(entry).sort()).toEqual(["command", "id", "name"]);
    }
  });

  test("正規表現を含まない（IPC で送れる形にする）", () => {
    // RegExp は structured clone を通らないため、レンダラへ渡す形からは外す
    expect(() => structuredClone(listProfiles())).not.toThrow();
  });

  test("定義されているプロファイルを全て返す", () => {
    expect(listProfiles().map((p) => p.id)).toEqual(AGENT_PROFILES.map((p) => p.id));
  });
});

test.describe("resolveProfile", () => {
  test("id で引ける", () => {
    expect(resolveProfile("codex").id).toBe("codex");
  });

  test("未知の id は既定にフォールバックする", () => {
    expect(resolveProfile("nonexistent-agent").id).toBe(DEFAULT_AGENT_ID);
  });

  test("未指定・null でも既定を返す", () => {
    expect(resolveProfile().id).toBe(DEFAULT_AGENT_ID);
    expect(resolveProfile(null).id).toBe(DEFAULT_AGENT_ID);
    expect(resolveProfile("").id).toBe(DEFAULT_AGENT_ID);
  });

  test("文字列でない値でも落ちずに既定を返す", () => {
    expect(resolveProfile(42).id).toBe(DEFAULT_AGENT_ID);
    expect(resolveProfile({}).id).toBe(DEFAULT_AGENT_ID);
  });
});

/**
 * claude の指示待ち / 確認待ちの分類（#27）。
 *
 * 下の 2 つは **実機の Claude Code v2.1.288 から採った出力**を、判定が見る形
 * （ANSI 除去後）に落として、パスとユーザー名を取り除いたもの。語が詰まって
 * 見えるのは列描画を除去した結果で、判定もこの形を見ている。
 *
 * 採り方: 空フォルダで `claude --permission-mode default` を起動し、ファイル
 * 作成を頼んで確認を出し、**Esc で断る**。auto mode を継承すると確認が出ずに
 * 自動承認されるので、このオプションが要る。
 */
test.describe("claude の ready / asking", () => {
  const claude = resolveProfile("claude");

  const READY_SCREEN = [
    "◐ medium · /effort",
    '❯ Try "fix lint errors"',
    "⏸ manual mode on · ? for shortcuts",
  ].join("\n");

  const PERMISSION_DIALOG = [
    "● Write(note.txt)",
    "Create file note.txt 1 hello",
    "Do you want to create note.tx?❯1Yes2. Yes,andswitchtoaccept edits" +
      " (auto-approve file edits and common file commands)forthissession(shift+tab)" +
      "  3. NoEsc to cancel · Tab to amend",
  ].join("\n");

  const status = (tail: string) =>
    detectStatus({
      tail,
      msSinceLastOutput: QUIET_MS + 100,
      waitingPatterns: claude.waitingPatterns,
      readyPatterns: claude.readyPatterns,
      askingPatterns: claude.askingPatterns,
    });

  test("入力欄で待っている画面は ready", () => {
    expect(status(READY_SCREEN)).toBe(STATUS.READY);
  });

  /** ダイアログの中にもカーソル `❯` が出る。asking を先に見ないと ready になる */
  test("権限の確認ダイアログは asking", () => {
    expect(status(PERMISSION_DIALOG)).toBe(STATUS.ASKING);
  });

  /**
   * 断った後もダイアログの残骸が記録に残る。`Esc to cancel` を印にすると
   * ここで asking に貼り付き、テキストが二度と届かなくなる
   */
  test("断った後は ready に戻る（残骸に引きずられない）", () => {
    const afterDecline = [
      "⎿  User rejected write to note.txt",
      "✻ Worked for 2s · done",
      "❯",
      "⏸ manual mode on · ? for shortcuts",
    ].join("\n");
    expect(status(afterDecline)).toBe(STATUS.READY);
  });

  /** 知らない選択式ダイアログ。ready には落とさない */
  test("見覚えのない選択式の画面は waiting に落ちる", () => {
    expect(status("Which approach do you prefer?\n❯ 1. A\n  2. B")).toBe(STATUS.WAITING);
  });
});

/**
 * codex は分割しない（#27）。
 *
 * 実機（gpt-5.5）から採った入力欄は `› Ask Codex to do anything`、選択肢は
 * `› 1. Yes, continue` で、**どちらも行頭 `›`**。入力欄の目印になりうるのは
 * 空のときだけ出る案内文で、利用者が何か打てば消える。
 *
 * 権限ダイアログは採れていない（採取時に使用上限に当たって応答まで到達
 * しなかった）。**見分けられる確証が無いので waiting のままにする。**
 * 分割すると、知らないダイアログが ready 側へ落ちる危険がある。
 */
test.describe("codex は見分けられないので waiting のまま", () => {
  const codex = resolveProfile("codex");

  const status = (tail: string) =>
    detectStatus({
      tail,
      msSinceLastOutput: QUIET_MS + 100,
      waitingPatterns: codex.waitingPatterns,
      readyPatterns: codex.readyPatterns,
      askingPatterns: codex.askingPatterns,
    });

  test("分割のパターンを持たない", () => {
    expect(codex.readyPatterns).toBeUndefined();
    expect(codex.askingPatterns).toBeUndefined();
  });

  test("入力欄は waiting", () => {
    expect(status("› Ask Codex to do anything\n  gpt-5.5 medium")).toBe(STATUS.WAITING);
  });

  /** 起動時のディレクトリ信頼の確認。実機から採取 */
  test("ディレクトリ信頼の確認も waiting", () => {
    const trust =
      "Do you trust the contents of this directory?" +
      "Working with untrusted contents comes with higher risk of prompt injection." +
      "› 1. Yes, continue2.No,quitPress enter to continue";
    expect(status(trust)).toBe(STATUS.WAITING);
  });
});
