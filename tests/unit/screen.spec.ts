import { test, expect } from "@playwright/test";
import { createScreen } from "../../lib/screen";

/**
 * 判定のための画面（#31）。
 *
 * pty のバイト列は「塗られたものすべての記録」で、全画面 TUI は変えた領域だけを
 * 塗り直す。記録の末尾は最後に塗られた場所にすぎず、画面とはずれる。
 * ここで確かめるのは、**ずれても画面が正しいまま**であること。
 */

/** xterm は書き込みを非同期に解釈するので、読む前に一度ティックを跨ぐ */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("書いたものが画面に出る", async () => {
  const screen = createScreen({ cols: 40, rows: 5 });
  screen.write("hello\r\nworld");
  await settled();

  expect(screen.read()).toContain("hello");
  expect(screen.read()).toContain("world");
  screen.dispose();
});

/**
 * #31 の核心。下の行にフッターを描いてから、上の行だけを何度も塗り替える。
 *
 * 記録の末尾には上の行しか残らないが、**画面にはフッターが出たまま**。
 * これが「仕事を終えたペインが指示待ちに戻らない」の正体だった。
 */
test("後から別の場所を塗っても、画面に残っているものは読める", async () => {
  const screen = createScreen({ cols: 60, rows: 10 });

  // 10 行目にフッターを描く
  screen.write("\x1b[10;1H⏸ manual mode on · ? for shortcuts");
  // そのあと 1 行目を何度も塗り替える（記録の末尾はこちらで埋まる）
  for (let i = 0; i < 50; i++) {
    screen.write(`\x1b[1;1H作業中 ${i} ................................`);
  }
  await settled();

  expect(screen.read()).toContain("manual mode on");
  expect(screen.read()).toContain("作業中 49");
  screen.dispose();
});

test("画面の外へ流れたものは残らない（履歴ではなく画面）", async () => {
  const screen = createScreen({ cols: 40, rows: 3 });
  screen.write("ふるい\r\n2\r\n3\r\n4\r\n5");
  await settled();

  expect(screen.read()).not.toContain("ふるい");
  expect(screen.read()).toContain("5");
  screen.dispose();
});

test("消した内容は画面からも消える", async () => {
  const screen = createScreen({ cols: 40, rows: 5 });
  screen.write("Do you want to create note.txt?");
  await settled();
  expect(screen.read()).toContain("Do you want to");

  // 画面を消して入力欄だけを描き直す（ダイアログに答えた後の動き）
  screen.write("\x1b[2J\x1b[H❯\r\n⏸ manual mode on");
  await settled();

  expect(screen.read()).not.toContain("Do you want to");
  expect(screen.read()).toContain("manual mode on");
  screen.dispose();
});

test("幅を変えると折り返しも変わる", async () => {
  const screen = createScreen({ cols: 10, rows: 4 });
  screen.write("abcdefghijklmno");
  await settled();
  expect(screen.read().split("\n")[0]).toBe("abcdefghij");

  screen.resize(20, 4);
  screen.write("\x1b[2J\x1b[Habcdefghijklmno");
  await settled();
  expect(screen.read().split("\n")[0]).toBe("abcdefghijklmno");
  screen.dispose();
});

test("行末の空白は落とす（中身のある行を数えられるように）", async () => {
  const screen = createScreen({ cols: 40, rows: 3 });
  screen.write("短い行");
  await settled();

  expect(screen.read().split("\n")[0]).toBe("短い行");
  screen.dispose();
});
