/**
 * PaneDeck の外から、設定ファイルの場所を決める（scripts/check-delivery.mjs が使う）。
 *
 * ★ **Electron の userData と同じ場所を指すこと。** 以前は `%APPDATA%`、無ければ
 * `~/.config` を見ていたので、**macOS では記録を見つけられなかった**（Electron の
 * macOS の置き場所は `~/Library/Application Support`）。Mac セッションに tealus#484 の
 * 試験を頼む直前に、コードを読んで気づいた（2026-10-10）。
 *
 * PaneDeck 本体は Electron に聞く（`app.getPath("userData")`）。ここはそれを持たない
 * スクリプト向けに、同じ規則を書き下したもの。
 */

import path from "path";

const APP_NAME = "panedeck";

export function defaultSettingsPath({
  platform,
  env,
  home,
}: {
  platform: string;
  env: Record<string, string | undefined>;
  home: string;
}): string {
  // 試験と PaneDeck 本体は、これで差し替える
  if (env.PANEDECK_SETTINGS_PATH) return env.PANEDECK_SETTINGS_PATH;

  let appData: string;
  if (platform === "win32") {
    appData = env.APPDATA || path.join(home, "AppData", "Roaming");
  } else if (platform === "darwin") {
    appData = path.join(home, "Library", "Application Support");
  } else {
    appData = env.XDG_CONFIG_HOME || path.join(home, ".config");
  }
  return path.join(appData, APP_NAME, "settings.json");
}
