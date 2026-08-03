import { test, expect } from "@playwright/test";
import {
  AGENT_PROFILES,
  DEFAULT_AGENT_ID,
  listProfiles,
  resolveProfile,
} from "../../lib/agent-profiles";
import { WAITING_PATTERNS } from "../../lib/status-detector";

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
