#!/usr/bin/env node
/* 发版前一键体检：版本真相、发布包完整性、哈希、源码包裁剪、正式包 stub。
 *
 *   node tools/verify-release.mjs                    # 完整体检（需要本地已打包）
 *   node tools/verify-release.mjs --version 1.4.10   # 覆盖期望版本号
 *   node tools/verify-release.mjs --skip-packages   # CI：只做版本一致性 + 清单 schema，不碰 zip
 *   node tools/verify-release.mjs --root <dir>      # 指定仓库根（供 test/verify-release-test.mjs 造场景）
 *
 * 每项打印 [OK]/[FAIL]，任一失败 exit 1；绝不改动任何文件，只读。
 * zip 完整性优先用系统 unzip -t；系统没有 unzip 时退回到内建的
 * 「中央目录 + CRC + inflateRaw」校验，不引入第三方依赖。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { validateMirrorsFile } from './validate-mirrors.mjs';

const HERE = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = resolve(dirname(HERE), '..');
const args = process.argv.slice(2);

function argValue(flag) {
  const i = args.indexOf(flag);
  if (i < 0) return null;
  if (!args[i + 1]) {
    console.error(`[verify-release] ${flag} 后面要跟取值`);
    process.exit(1);
  }
  return args[i + 1];
}
const skipPackages = args.includes('--skip-packages');
const optVersion = argValue('--version');
const optRoot = argValue('--root');
const ROOT = optRoot ? resolve(optRoot) : DEFAULT_ROOT;
const rel = p => relative(ROOT, p) || p;

/* --------------------------- ZIP 读取（含兜底） --------------------------- */
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

/** 按 ZIP 中央目录读回全部条目，逐条校验大小与 CRC；不依赖系统 unzip。 */
function readZipEntries(buf) {
  const map = new Map();
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('找不到 ZIP 结束记录 EOCD');
  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目录签名错误 @' + off);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const loff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    if (buf.readUInt32LE(loff) !== 0x04034b50) throw new Error(name + ': local header 签名错误');
    const lnlen = buf.readUInt16LE(loff + 26);
    const lelen = buf.readUInt16LE(loff + 28);
    const start = loff + 30 + lnlen + lelen;
    const comp = buf.subarray(start, start + csize);
    let data;
    if (method === 8) data = inflateRawSync(comp);
    else if (method === 0) data = Buffer.from(comp);
    else throw new Error(name + ': 不支持的压缩方法 ' + method);
    if (data.length !== usize) throw new Error(name + ': 解压后大小不符');
    if (crc32(data) !== crc) throw new Error(name + ': CRC 校验失败');
    map.set(name, data);
    off += 46 + nlen + elen + clen;
  }
  return map;
}

let hasUnzipCache = null;
function hasUnzip() {
  if (hasUnzipCache === null) {
    try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); hasUnzipCache = true; }
    catch { hasUnzipCache = false; }
  }
  return hasUnzipCache;
}
function unzip(argv) {
  return execFileSync('unzip', argv, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function testZip(zipPath) {
  if (hasUnzip()) {
    let out;
    try { out = unzip(['-t', zipPath]); }
    catch (e) { return { ok: false, detail: 'unzip -t 失败：' + String(e.message || '').split('\n')[0] }; }
    if (!/No errors detected/i.test(out)) return { ok: false, detail: 'unzip -t 未报告 No errors detected' };
    return { ok: true, detail: 'unzip -t 无错' };
  }
  try {
    const m = readZipEntries(readFileSync(zipPath));
    return { ok: true, detail: `内建 ZIP 校验（${m.size} 个条目，系统无 unzip）` };
  } catch (e) {
    return { ok: false, detail: '内建 ZIP 校验失败：' + e.message };
  }
}
function listZip(zipPath) {
  if (hasUnzip()) {
    try { return unzip(['-Z1', zipPath]).trim().split(/\r?\n/).filter(Boolean); }
    catch { /* 落到内建解析 */ }
  }
  return [...readZipEntries(readFileSync(zipPath)).keys()];
}
function readEntry(zipPath, name) {
  if (hasUnzip()) {
    try { return unzip(['-p', zipPath, name]); }
    catch { /* 落到内建解析 */ }
  }
  const map = readZipEntries(readFileSync(zipPath));
  if (!map.has(name)) throw new Error('包内缺少 ' + name);
  return map.get(name).toString('utf8');
}

/* ------------------------------ 检查框架 ------------------------------ */
const results = [];
function check(label, fn) {
  let ok = false, detail = '';
  try {
    const r = fn();
    ok = r === true || (r && r.ok === true);
    if (r && typeof r === 'object') detail = r.detail || '';
  } catch (e) {
    detail = e.message || String(e);
  }
  results.push({ label, ok });
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${label}${detail ? '  — ' + detail : ''}`);
}
function loadJson(relPath) {
  try { return { ok: true, value: JSON.parse(readFileSync(join(ROOT, relPath), 'utf8')) }; }
  catch (e) { return { ok: false, error: e.message }; }
}
const sha256 = buf => createHash('sha256').update(buf).digest('hex');

/* 与 tools/pack.mjs 的 excluded() 等价（rel 已剥掉源码包外层前缀）。 */
const SRC_EXCLUDE = r =>
  /^dist\//.test(r) || /^node_modules\//.test(r) || /^\.git\//.test(r) ||
  /^store\//.test(r) || /^archive\//.test(r) || /^docs\//.test(r) ||
  /^test\/probe-/.test(r) || /^test\/fs-capability\.mjs$/.test(r) ||
  /\.zip$/.test(r) || /\.log$/.test(r) ||
  /(^|\/)auth\.txt$/.test(r) || /(^|\/)outbox\.txt$/.test(r) ||
  /(^|\/)_mfl-tasks\//.test(r) || /\.task\.json$/.test(r) ||
  /(^|\/)\.env(\.|$)/.test(r) || /\.tmp$/.test(r);

/* ------------------------------- 主流程 ------------------------------- */
console.log(`[verify-release] 根目录 ${ROOT}${skipPackages ? '  （skip-packages / CI 模式）' : ''}`);

const m = loadJson('manifest.json');
const p = loadJson('package.json');
check('版本真相：manifest.json / package.json 可读', () => ({
  ok: m.ok && p.ok,
  detail: m.ok && p.ok ? `manifest ${m.value.version} / package ${p.value.version}` : (m.error || p.error),
}));
const pkgVersion = p.ok ? p.value.version : null;
const expected = optVersion || pkgVersion;

check('版本一致：manifest.json 与 package.json', () => ({
  ok: m.ok && p.ok && m.value.version === p.value.version,
  detail: `manifest ${m.ok ? m.value.version : '?'} / package ${pkgVersion ?? '?'}`,
}));
if (optVersion) {
  check('--version 覆盖值与 package.json 一致', () => ({
    ok: pkgVersion === optVersion,
    detail: `--version ${optVersion} / package ${pkgVersion ?? '?'}`,
  }));
}
check('清单 schema：data/builtin-mirrors.json', () => {
  const r = validateMirrorsFile(join(ROOT, 'data', 'builtin-mirrors.json'));
  return {
    ok: !r.errors.length,
    detail: r.errors.length ? r.errors.join('；') : `${r.doc.mirrors.length} 条镜像，updated ${r.doc.updated}`,
  };
});

if (!skipPackages) {
  const bi = loadJson('store/packages/build-info.json');
  check('build-info.json 可读', () => ({
    ok: bi.ok,
    detail: bi.ok ? `version ${bi.value.version}，${(bi.value.packages || []).length} 个包` : bi.error,
  }));
  check('build-info.json version 与期望版本一致', () => ({
    ok: bi.ok && bi.value.version === expected,
    detail: `build-info ${bi.ok ? bi.value.version : '?'} / 期望 ${expected ?? '?'}`,
  }));

  let readme = '';
  try { readme = readFileSync(join(ROOT, 'store', 'README.md'), 'utf8'); } catch { /* 下面记 FAIL */ }
  check('store/README.md 可读', () => ({ ok: !!readme, detail: readme ? `${readme.length} 字符` : '读不到' }));

  const info = bi.ok ? bi.value : { packages: [] };
  const packages = Array.isArray(info.packages) ? info.packages : [];
  const byTarget = {};
  for (const t of ['edge', 'firefox', 'source']) {
    const rec = packages.find(x => x && x.target === t);
    if (!rec) {
      check(`${t}: build-info.json 有该包记录`, () => ({ ok: false, detail: '缺少 target=' + t }));
      continue;
    }
    byTarget[t] = rec;
    const zip = join(ROOT, 'store', 'packages', rec.file);
    const exists = existsSync(zip);
    const wantSha = String(rec.sha256 || '');

    check(`${t}: zip 存在且 unzip -t 无错`, () => {
      if (!exists) return { ok: false, detail: `缺少 ${rel(zip)}` };
      return testZip(zip);
    });

    let actual = null;
    check(`${t}: bytes / sha256 与 build-info.json 一致`, () => {
      if (!exists) return { ok: false, detail: 'zip 不存在' };
      const buf = readFileSync(zip);
      actual = { bytes: buf.length, sha256: sha256(buf) };
      return {
        ok: actual.bytes === rec.bytes && actual.sha256 === wantSha,
        detail: `实际 ${actual.bytes} B / ${actual.sha256.slice(0, 8)}… · 记录 ${rec.bytes} B / ${wantSha.slice(0, 8)}…`,
      };
    });
    check(`${t}: SHA-256 前 8 位见于 store/README.md`, () => {
      const prefix = (actual ? actual.sha256 : wantSha).slice(0, 8);
      return { ok: !!prefix && readme.includes(prefix), detail: `前缀 ${prefix}` };
    });
  }

  /* 源码包裁剪：与 pack.mjs 的 excluded() 同一套规则 */
  const srcRec = byTarget.source;
  check('源码包不含 dist/、store/、archive/、docs/、auth.txt、嵌套 .zip', () => {
    if (!srcRec) return { ok: false, detail: 'build-info.json 没有 source 记录' };
    const zip = join(ROOT, 'store', 'packages', srcRec.file);
    if (!existsSync(zip)) return { ok: false, detail: '源码包不存在' };
    const names = listZip(zip);
    const prefix = `mirror-fastlane-source-${expected}/`;
    if (!names.some(n => n.startsWith(prefix))) {
      return { ok: false, detail: `条目缺少预期前缀 ${prefix}` };
    }
    const bad = [];
    for (const full of names) {
      const r = full.startsWith(prefix) ? full.slice(prefix.length) : full;
      if (SRC_EXCLUDE(r)) bad.push(r);
    }
    return {
      ok: !bad.length,
      detail: bad.length ? `违规 ${bad.length} 项：${bad.slice(0, 6).join(', ')}` : `${names.length} 个条目，无违规`,
    };
  });

  /* 正式包必须把调试实现换成 stub、去掉设置页调试面板 */
  for (const t of ['edge', 'firefox']) {
    const rec = byTarget[t];
    const zip = rec ? join(ROOT, 'store', 'packages', rec.file) : null;
    check(`${t}: lib/debug-log.js 是 no-op stub`, () => {
      if (!zip || !existsSync(zip)) return { ok: false, detail: 'zip 不存在' };
      const s = readEntry(zip, 'lib/debug-log.js');
      const size = Buffer.byteLength(s, 'utf8');
      const hasLog = s.includes('console.log');
      return { ok: size <= 2000 && !hasLog, detail: `${size} B，含 console.log=${hasLog}` };
    });
    check(`${t}: options/options.html 无调试面板标记`, () => {
      if (!zip || !existsSync(zip)) return { ok: false, detail: 'zip 不存在' };
      const s = readEntry(zip, 'options/options.html');
      const marked = s.includes('MFL_DEBUG_PANEL_START') || s.includes('MFL_DEBUG_PANEL_END');
      return { ok: !marked, detail: marked ? '仍含调试面板标记' : '无标记' };
    });
  }
}

const failed = results.filter(r => !r.ok);
console.log(`\n[verify-release] ${results.length - failed.length}/${results.length} 项通过` +
  (failed.length ? `，${failed.length} 项失败` : ' — 体检通过'));
if (failed.length) {
  for (const f of failed) console.error('  FAIL: ' + f.label);
  process.exit(1);
}
