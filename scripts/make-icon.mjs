/**
 * build/icon.svg から build/icon.png を作る。
 *
 * electron-builder は 1024x1024 の PNG が 1 枚あれば、各 OS 向けの
 * .ico / .icns を自前で生成する。手で 3 種類そろえる必要はない。
 *
 * SVG が正なので、PNG は生成物として扱う（コミットはする。ビルド機に
 * sharp を入れずに済むよう、また生成物の見た目を差分で追えるようにするため）。
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(here, "..", "build");

const source = path.join(buildDir, "icon.svg");
const target = path.join(buildDir, "icon.png");

const SIZE = 1024;

await sharp(fs.readFileSync(source), { density: 384 })
  .resize(SIZE, SIZE)
  .png()
  .toFile(target);

console.log(`${path.relative(process.cwd(), target)} (${SIZE}x${SIZE})`);
