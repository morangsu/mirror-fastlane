/* 生成三个发布 zip：Edge 上架包、Firefox 上架包、AMO 源码包。
 *
 * 只用 Node 内置模块（zlib / crypto），无第三方依赖、无网络。
 * 时间戳固定，保证同一份源码产出同一份字节，便于用 SHA-256 复核。
 * 运行： node tools/pack.mjs   （npm run store 会自动调用）
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'store', 'packages');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

/* ------------------------------- CRC32 ------------------------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------- ZIP 写入 ------------------------------- */
// 固定 DOS 时间戳 2026-11-07 16:00:00，保证可复现
const DOS_TIME = (16 << 11) | (0 << 5) | 0;
const DOS_DATE = ((2026 - 1980) << 9) | (11 << 5) | 7;

function makeZip(entries, comment) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    // ZIP 的 method=8 要求 raw deflate（无 zlib 头），不能用 deflateSync
    const comp = deflateRawSync(e.data, { level: 9 });

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);            // version needed
    lh.writeUInt16LE(0, 6);             // flags
    lh.writeUInt16LE(8, 8);             // method = deflate
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);            // version made by
    ch.writeUInt16LE(20, 6);            // version needed
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);            // extra length
    ch.writeUInt16LE(0, 32);            // comment length
    ch.writeUInt16LE(0, 34);            // disk start
    ch.writeUInt16LE(0, 36);            // internal attrs
    ch.writeUInt32LE(0, 38);            // external attrs
    ch.writeUInt32LE(offset, 42);       // local header offset
    centrals.push(ch, name);

    offset += lh.length + name.length + comp.length;
  }

  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const commentBuf = Buffer.from(comment || '', 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(commentBuf.length, 20);

  return Buffer.concat([localBuf, centralBuf, eocd, commentBuf]);
}

function collect(dir, prefix, exclude) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const rel = prefix ? prefix + '/' + name : name;
    if (exclude && exclude(rel, name)) continue;
    if (statSync(p).isDirectory()) out.push(...collect(p, rel, exclude));
    else out.push({ name: rel, data: readFileSync(p) });
  }
  return out;
}

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

function commitHash() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim(); }
  catch { return 'uncommitted'; }
}

/* ------------------------------- 打包 ------------------------------- */
mkdirSync(OUT, { recursive: true });
const sha = commitHash();
// zip comment 只写版本号：写 commit hash 会造成「提交 → 打包 → 哈希变 → 改文档 → 再提交」的循环依赖
const comment = `mirror-fastlane ${VERSION}`;
const info = { version: VERSION, commit: sha, generatedBy: 'node tools/pack.mjs', packages: [] };

// 上架包：dist/<target> 根目录直接展开，不带外层文件夹
for (const target of ['edge', 'firefox']) {
  const src = join(ROOT, 'dist', target);
  if (!existsSync(src)) throw new Error('缺少构建产物 ' + src + '，请先 npm run build');
  const entries = collect(src, '');
  const buf = makeZip(entries, comment);
  const file = `mirror-fastlane-${target}-${VERSION}.zip`;
  writeFileSync(join(OUT, file), buf);
  const rec = { file, target, bytes: buf.length, sha256: sha256(buf), entries: entries.length };
  info.packages.push(rec);
  console.log(`[pack] ${file}  ${rec.bytes} B  ${entries.length} 个文件  sha256 ${rec.sha256}`);
}

// 源码包：只保留构建可复现所需的源码与说明，剔除一次性探针、商店内部话术与本地产物
const srcPrefix = `mirror-fastlane-source-${VERSION}`;
// rel 带 srcPrefix 前缀，判断前先剥掉，否则所有 ^xxx/ 规则都会失效
const exclude = full => {
  const rel = full.startsWith(srcPrefix + '/') ? full.slice(srcPrefix.length + 1) : full;
  return /^dist\//.test(rel) || /^node_modules\//.test(rel) || /^\.git\//.test(rel) ||
    /^store\//.test(rel) || /^archive\//.test(rel) || /^docs\//.test(rel) || /^test\/probe-/.test(rel) ||
    /^test\/fs-capability\.mjs$/.test(rel) ||
    /\.zip$/.test(rel) || /\.log$/.test(rel) ||
    /(^|\/)auth\.txt$/.test(rel) || /(^|\/)outbox\.txt$/.test(rel) ||
    /(^|\/)_mfl-tasks\//.test(rel) || /\.task\.json$/.test(rel) ||
    /(^|\/)\.env(\.|$)/.test(rel) || /\.tmp$/.test(rel);
};
const srcEntries = collect(ROOT, srcPrefix, exclude);
const srcBuf = makeZip(srcEntries, comment);
const srcFile = `${srcPrefix}.zip`;
writeFileSync(join(OUT, srcFile), srcBuf);
const srcRec = { file: srcFile, target: 'source', bytes: srcBuf.length, sha256: sha256(srcBuf), entries: srcEntries.length };
info.packages.push(srcRec);
console.log(`[pack] ${srcFile}  ${srcRec.bytes} B  ${srcEntries.length} 个文件  sha256 ${srcRec.sha256}`);

writeFileSync(join(OUT, 'build-info.json'), JSON.stringify(info, null, 2) + '\n', 'utf8');
console.log(`[pack] commit ${sha} → store/packages/build-info.json`);
