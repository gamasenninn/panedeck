import { test, expect } from "@playwright/test";
import { execFileSync } from "child_process";
import path from "path";

/**
 * インストーラが PATH を通す（2026-10-11）。`code .` と同じく `panedeck .` で起動できるように。
 *
 * build/path-entry.ps1 をインストーラとアンインストーラが呼ぶ。ここでは実物の
 * スクリプトをそのまま走らせる。
 *
 * ★ PATH は壊すと他のアプリまで動かなくなる。だから「自分の 1 項目以外に触らない」
 * ことを厚めに確かめる。値の種類（REG_EXPAND_SZ）を変えると `%USERPROFILE%` などが
 * 展開済みの文字列に焼き付くので、レジストリへ書く経路も試験用のキーで確かめる
 */
const SCRIPT = path.resolve(__dirname, "..", "..", "build", "path-entry.ps1");
const DIR = "C:\\Users\\me\\AppData\\Local\\Programs\\PaneDeck";
const TEST_KEY = "HKCU:\\Software\\PaneDeckTest\\Environment";

test.skip(process.platform !== "win32", "Windows のインストーラ用");

function ps(args: string[]): string {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args],
    { encoding: "utf8" }
  ).replace(/\r?\n$/, "");
}

/** レジストリに触らず、新しい値だけを返させる */
function compute(action: "add" | "remove", value: string): string {
  return ps(["-Action", action, "-Dir", DIR, "-Value", value]);
}

function runPs(command: string): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
  }).trim();
}

test.describe("PATH の値の組み立て", () => {
  test("足すと末尾に付く", () => {
    expect(compute("add", "C:\\a;C:\\b")).toBe(`C:\\a;C:\\b;${DIR}`);
  });

  test("末尾が ; でも ; を重ねない", () => {
    expect(compute("add", "C:\\a;")).toBe(`C:\\a;${DIR}`);
  });

  test("空なら、それだけになる", () => {
    expect(compute("add", "")).toBe(DIR);
  });

  /** 入れ直し（上書きインストール）のたびに増えていかない */
  test("もう入っていれば変えない（大文字小文字・末尾の \\ の違いは同じとみなす）", () => {
    const value = `C:\\a;${DIR.toLowerCase()}\\;C:\\b`;
    expect(compute("add", value)).toBe(value);
  });

  test("外すと自分の項目だけが消え、他はそのまま残る", () => {
    expect(compute("remove", `C:\\a;${DIR};%USERPROFILE%\\bin;;C:\\b`)).toBe(
      "C:\\a;%USERPROFILE%\\bin;;C:\\b"
    );
  });

  test("外すとき、大文字小文字・末尾の \\ の違いがあっても外れる", () => {
    expect(compute("remove", `C:\\a;${DIR.toUpperCase()}\\`)).toBe("C:\\a");
  });

  test("入っていなければ変えない", () => {
    expect(compute("remove", "C:\\a;C:\\b")).toBe("C:\\a;C:\\b");
  });
});

test.describe("レジストリへの書き込み（試験用のキー）", () => {
  test.beforeEach(() => {
    runPs(`New-Item -Path '${TEST_KEY}' -Force | Out-Null`);
  });

  test.afterAll(() => {
    runPs(`Remove-Item -Path 'HKCU:\\Software\\PaneDeckTest' -Recurse -Force -ErrorAction SilentlyContinue`);
  });

  const readRaw = () =>
    runPs(
      `(Get-Item '${TEST_KEY}').GetValue('Path', '', 'DoNotExpandEnvironmentNames')`
    );
  const readKind = () => runPs(`(Get-Item '${TEST_KEY}').GetValueKind('Path')`);

  test("%VAR% を展開せずに残し、値の種類（ExpandString）も変えない", () => {
    runPs(
      `New-ItemProperty -Path '${TEST_KEY}' -Name Path -PropertyType ExpandString -Value '%USERPROFILE%\\bin' -Force | Out-Null`
    );
    ps(["-Action", "add", "-Dir", DIR, "-Key", TEST_KEY]);

    expect(readRaw()).toBe(`%USERPROFILE%\\bin;${DIR}`);
    expect(readKind()).toBe("ExpandString");
  });

  test("ふつうの文字列（String）なら、そのまま String で書く", () => {
    runPs(
      `New-ItemProperty -Path '${TEST_KEY}' -Name Path -PropertyType String -Value 'C:\\a' -Force | Out-Null`
    );
    ps(["-Action", "add", "-Dir", DIR, "-Key", TEST_KEY]);

    expect(readRaw()).toBe(`C:\\a;${DIR}`);
    expect(readKind()).toBe("String");
  });

  test("Path が無ければ ExpandString で作る", () => {
    ps(["-Action", "add", "-Dir", DIR, "-Key", TEST_KEY]);

    expect(readRaw()).toBe(DIR);
    expect(readKind()).toBe("ExpandString");
  });

  test("外すと自分の項目だけが消える", () => {
    runPs(
      `New-ItemProperty -Path '${TEST_KEY}' -Name Path -PropertyType ExpandString -Value 'C:\\a;${DIR}' -Force | Out-Null`
    );
    ps(["-Action", "remove", "-Dir", DIR, "-Key", TEST_KEY]);

    expect(readRaw()).toBe("C:\\a");
  });
});
