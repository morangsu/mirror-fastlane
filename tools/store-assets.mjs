/* 生成商店用图：Logo 300 / 512（Edge 要求 300×300，AMO 建议 512）
 * 运行： node tools/store-assets.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIcon } from '../build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'store');

mkdirSync(OUT, { recursive: true });

for (const size of [300, 512]) {
  const p = join(OUT, `logo-${size}.png`);
  writeFileSync(p, makeIcon(size));
  console.log(`[logo] ${p}  ${size}x${size}`);
}
