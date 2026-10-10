import { test, expect } from "@playwright/test";
import path from "path";
import { defaultSettingsPath } from "../../lib/app-paths";

/**
 * PaneDeck の外から設定の場所を決める（scripts/check-delivery.mjs が使う）。
 *
 * ★ **Electron の userData と同じ場所を指すこと。** 以前は `%APPDATA%`、無ければ
 * `~/.config` を見ていたので、**macOS では記録を見つけられなかった**
 * （Electron の macOS の置き場所は `~/Library/Application Support`）。
 * Mac セッションに tealus#484 の試験を頼む直前に、コードを読んで気づいた。
 */
test.describe("defaultSettingsPath", () => {
  test("Windows は %APPDATA%\\panedeck", () => {
    expect(
      defaultSettingsPath({ platform: "win32", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, home: "C:\\Users\\u" })
    ).toBe(path.join("C:\\Users\\u\\AppData\\Roaming", "panedeck", "settings.json"));
  });

  test("macOS は ~/Library/Application Support/panedeck", () => {
    expect(defaultSettingsPath({ platform: "darwin", env: {}, home: "/Users/u" })).toBe(
      path.join("/Users/u", "Library", "Application Support", "panedeck", "settings.json")
    );
  });

  test("Linux は $XDG_CONFIG_HOME、無ければ ~/.config", () => {
    expect(defaultSettingsPath({ platform: "linux", env: { XDG_CONFIG_HOME: "/x" }, home: "/home/u" })).toBe(
      path.join("/x", "panedeck", "settings.json")
    );
    expect(defaultSettingsPath({ platform: "linux", env: {}, home: "/home/u" })).toBe(
      path.join("/home/u", ".config", "panedeck", "settings.json")
    );
  });

  test("PANEDECK_SETTINGS_PATH があれば、それを使う（試験と PaneDeck 本体と同じ）", () => {
    expect(
      defaultSettingsPath({ platform: "darwin", env: { PANEDECK_SETTINGS_PATH: "/tmp/s.json" }, home: "/Users/u" })
    ).toBe("/tmp/s.json");
  });
});
