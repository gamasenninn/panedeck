/**
 * `ServiceRunner` に渡す、実プロセスの起動（#29）。
 *
 * **Windows で子を残さないこと**がこのファイルの要点。`child.kill()` は
 * 起動したプロセスだけを終わらせるので、それがシェル経由なら**その先の
 * 孫は生き残る**。`sh -c "node stream.js"` のような書き方が普通である以上、
 * 残るのが既定の振る舞いになってしまう。
 *
 * そこで Windows ではプロセスツリーごと落とす（`taskkill /T`）。他の OS では
 * プロセスグループへシグナルを送る。
 *
 * ここだけが child_process を知っている。`ServiceRunner` は `ServiceProcess`
 * という形だけを受け取るので、lib/ の他は依存しないままでいられる。
 */

import { spawn as spawnProcess } from "child_process";

import type { ServiceProcess } from "./service-runner";

const isWindows = process.platform === "win32";

export function spawnService(command: string): ServiceProcess {
  const child = spawnProcess(command, {
    shell: true,
    windowsHide: true,
    // 他の OS では、自分を長とするプロセスグループにして、まとめて落とせるように
    detached: !isWindows,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const outHandlers: Array<(text: string) => void> = [];
  const errHandlers: Array<(text: string) => void> = [];
  const exitHandlers: Array<(code: number) => void> = [];

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (text: string) => outHandlers.forEach((cb) => cb(text)));
  child.stderr?.on("data", (text: string) => errHandlers.forEach((cb) => cb(text)));

  // 起動そのものに失敗した場合も「終了」として扱う。黙って止まらせない
  child.on("error", (err) => {
    errHandlers.forEach((cb) => cb(`${err.message}\n`));
    exitHandlers.forEach((cb) => cb(-1));
  });
  child.on("exit", (code) => exitHandlers.forEach((cb) => cb(code ?? -1)));

  return {
    onStdout: (cb) => outHandlers.push(cb),
    onStderr: (cb) => errHandlers.push(cb),
    onExit: (cb) => exitHandlers.push(cb),

    kill() {
      if (child.pid === undefined) return;
      try {
        if (isWindows) {
          // /T で子孫ごと、/F で強制。shell: true の先にいる孫はこれでないと残る
          spawnProcess("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
          });
        } else {
          // マイナスの pid はプロセスグループ宛て
          process.kill(-child.pid, "SIGTERM");
        }
      } catch {
        // すでに居ないなら何もしなくてよい
      }
    },
  };
}
