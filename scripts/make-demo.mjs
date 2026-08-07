/**
 * 収録した動画（.demo/*.webm）を README 用の GIF に変換する。
 *
 *     npm run demo        # 収録 → 変換
 *
 * **追加のインストールを要らなくしてある。** Playwright の ffmpeg でコマ画像を
 * 書き出し、GIF への組み立てはアイコン生成で既に使っている sharp が行う。
 * 録画できた環境なら ffmpeg は必ず入っているので、それ以上何も要らない。
 *
 * Playwright の ffmpeg は最小構成で、**gif エンコーダも palettegen も持って
 * いない**（持っているのは png と scale）。ffmpeg 1 本で済ませようとすると
 * ここで詰まる。減色は sharp（libvips）に任せる。
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VIDEO_DIR = path.join(ROOT, ".demo");
const FRAME_DIR = path.join(VIDEO_DIR, "frames");
const OUTPUT = path.join(ROOT, "docs", "demo.gif");

/** GIF の見た目。幅は README の描画幅に、色数は端末描画に合わせて絞る */
const FPS = 10;
const WIDTH = 900;
const COLOURS = 96;

function playwrightCacheDir() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  }
  return path.join(os.homedir(), ".cache", "ms-playwright");
}

function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;

  const cache = playwrightCacheDir();
  if (fs.existsSync(cache)) {
    for (const entry of fs.readdirSync(cache)) {
      if (!entry.startsWith("ffmpeg-")) continue;
      const dir = path.join(cache, entry);
      const binary = fs
        .readdirSync(dir)
        .find((name) => name.startsWith("ffmpeg") && !name.endsWith(".json"));
      if (binary) return path.join(dir, binary);
    }
  }
  return "ffmpeg";
}

function newestVideo() {
  if (!fs.existsSync(VIDEO_DIR)) return null;
  const videos = fs
    .readdirSync(VIDEO_DIR)
    .filter((name) => name.endsWith(".webm"))
    .map((name) => ({ name, at: fs.statSync(path.join(VIDEO_DIR, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);

  return videos.length ? path.join(VIDEO_DIR, videos[0].name) : null;
}

const video = newestVideo();
if (!video) {
  console.error(
    "収録した動画が見つかりません。先に npx playwright test --project=demo を実行してください。"
  );
  process.exit(1);
}

// --- コマ画像に分解する -----------------------------------------------------

const ffmpeg = findFfmpeg();
fs.rmSync(FRAME_DIR, { recursive: true, force: true });
fs.mkdirSync(FRAME_DIR, { recursive: true });

try {
  execFileSync(
    ffmpeg,
    [
      "-y",
      "-i", video,
      "-vf", `scale=${WIDTH}:-1:flags=lanczos`,
      // コマ落としはフィルタ（fps）ではなく出力レートで指定する。
      // 同梱の ffmpeg は scale など数個しかフィルタを持っていない
      "-r", String(FPS),
      path.join(FRAME_DIR, "%05d.png"),
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
} catch (error) {
  console.error(`ffmpeg の実行に失敗しました (${ffmpeg})`);
  console.error(String(error.stderr ?? "").split("\n").slice(-5).join("\n"));
  process.exit(1);
}

const frames = fs
  .readdirSync(FRAME_DIR)
  .filter((name) => name.endsWith(".png"))
  .sort()
  .map((name) => path.join(FRAME_DIR, name));

if (frames.length < 2) {
  console.error("コマ画像を書き出せませんでした。");
  process.exit(1);
}

// --- GIF に組み立てる -------------------------------------------------------

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });

await sharp(frames, { join: { across: 1, animated: true } })
  .gif({ delay: Math.round(1000 / FPS), loop: 0, colours: COLOURS })
  .toFile(OUTPUT);

fs.rmSync(FRAME_DIR, { recursive: true, force: true });

const mb = (fs.statSync(OUTPUT).size / 1024 / 1024).toFixed(2);
console.log(
  `${path.relative(ROOT, OUTPUT)} を書き出しました ` +
    `(${mb} MB, ${WIDTH}px, ${FPS}fps, ${frames.length} コマ, ${COLOURS} 色)`
);
