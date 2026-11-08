#!/usr/bin/env node
/* 把 store/packages/build-info.json 里的真实体积与 SHA-256 同步进 store/README.md。
 * 以前靠手抄，漏一次就与 zip 不符；npm run check:release 会拦，但不如直接生成。
 * 只改「含包名 + SHA-256」的那几行，其余文案与换行一律不动。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const infoPath = join(ROOT, 'store', 'packages', 'build-info.json');
const readmePath = join(ROOT, 'store', 'README.md');
if (!existsSync(infoPath)) {
  console.error('[sync] 找不到 build-info.json，先运行 npm run pack');
  process.exit(1);
}
const info = JSON.parse(readFileSync(infoPath, 'utf8'));
if (!Array.isArray(info.packages) || !info.packages.length) {
  console.error('[sync] build-info.json 里没有 packages');
  process.exit(1);
}

let text = readFileSync(readmePath, 'utf8');
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const lines = text.split(/\r?\n/);
let changed = 0;

for (const p of info.packages) {
  const bytes = Number(p.bytes).toLocaleString('en-US');   // 不含单位，拼进正则替换串时只加一次
  const sha8 = String(p.sha256).slice(0, 8);
  const idx = lines.findIndex(l => l.includes(p.file) && l.includes('SHA-256'));
  if (idx < 0) {
    console.error('[sync] store/README.md 里找不到 ' + p.file + ' 的哈希行');
    process.exit(1);
  }
  const before = lines[idx];
  // 必须能匹配到「体积 + 前 8 位哈希」才动手；匹配不到说明 README 格式被改坏了，应报错
  const RE = /[\d,]+ B，SHA-256 `[0-9a-f]{8}…`/;
  if (!RE.test(before)) {
    console.error('[sync] ' + p.file + ' 这一行没匹配到「体积 / 哈希」格式');
    process.exit(1);
  }
  const after = before.replace(RE, bytes + ' B，SHA-256 `' + sha8 + '…`');
  // 值已经一致是正常情况（重复跑 pack/sync），不是错误
  if (after === before) {
    console.log('  ' + p.file + ' 已是最新（' + bytes + ' B ' + sha8 + '…）');
  } else {
    lines[idx] = after;
    changed++;
    console.log('  ' + p.file + ' → ' + bytes + ' B  ' + sha8 + '…');
  }
}

writeFileSync(readmePath, lines.join(eol), 'utf8');
console.log('[sync] 已更新 ' + changed + ' 行；换行保持 ' + (eol === '\r\n' ? 'CRLF' : 'LF'));
