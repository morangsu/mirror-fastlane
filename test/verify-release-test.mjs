/* tools/verify-release.mjs 回归测试
 *
 * 完全自包含：在临时目录里用 Node 内置模块现造一套最小「发布产物」
 * （3 个 zip + build-info.json + store/README.md + 版本文件 + 清单），
 * 不读取、不覆盖、不删除真实的 store/packages/。
 * 逐个构造坏场景，验证体检脚本确实非零退出并报出对应检查项；正常场景应 exit 0。
 *
 * 运行：node test/verify-release-test.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'tools', 'verify-release.mjs');
const V = '1.4.12';
const SRC_PREFIX = `mirror-fastlane-source-${V}`;
const sha256 = buf => createHash('sha256').update(buf).digest('hex');

/* --------------------------- 极简 ZIP 写入（method=0 stored） --------------------------- */
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
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;

function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);            // method = stored
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, f.data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(f.data.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += 30 + name.length + f.data.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

/* --------------------------- 造一套干净的发布产物 --------------------------- */
const STUB = '/* Production build stub */\n(function (root) { root.DBG = { enabled: false, log: function () {} }; })(globalThis);\n';
const OPTIONS_HTML = '<!doctype html>\n<html><body>options</body></html>\n';

function prodFiles() {
  return [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ version: V })) },
    { name: 'lib/debug-log.js', data: Buffer.from(STUB) },
    { name: 'options/options.html', data: Buffer.from(OPTIONS_HTML) },
  ];
}
function sourceFiles() {
  return [
    { name: `${SRC_PREFIX}/manifest.json`, data: Buffer.from(JSON.stringify({ version: V })) },
    { name: `${SRC_PREFIX}/build.mjs`, data: Buffer.from('// build\n') },
  ];
}
function writeTo(dir, relPath, data) {
  const p = join(dir, relPath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
}
const zips = () => ({
  edge: makeZip(prodFiles()),
  firefox: makeZip(prodFiles()),
  source: makeZip(sourceFiles()),
});
function buildInfo(z) {
  return {
    version: V,
    commit: 'test-fixture',
    generatedBy: 'test/verify-release-test.mjs',
    packages: Object.keys(z).map(target => ({
      file: `mirror-fastlane-${target}-${V}.zip`,
      target,
      bytes: z[target].length,
      sha256: sha256(z[target]),
      entries: 0,
    })),
  };
}
function readmeFor(info) {
  return '# 测试用商店清单\n\n' +
    info.packages.map(r => `- ${r.file}（${r.bytes} B，SHA-256 \`${r.sha256.slice(0, 8)}…\`）`).join('\n') + '\n';
}
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'mfl-verify-release-'));
  const z = zips();
  const info = buildInfo(z);
  writeTo(dir, 'manifest.json', JSON.stringify({ name: 'fixture', version: V }, null, 2) + '\n');
  writeTo(dir, 'package.json', JSON.stringify({ name: 'fixture', version: V }, null, 2) + '\n');
  writeTo(dir, 'data/builtin-mirrors.json', JSON.stringify({
    updated: '2026-11-08',
    mirrors: [{ name: 'A', base: 'https://a.example.com' }, { name: 'B', base: 'https://b.example.com' }],
  }, null, 2) + '\n');
  writeTo(dir, 'store/README.md', readmeFor(info));
  writeTo(dir, 'store/packages/build-info.json', JSON.stringify(info, null, 2) + '\n');
  for (const target of Object.keys(z)) {
    writeTo(dir, `store/packages/mirror-fastlane-${target}-${V}.zip`, z[target]);
  }
  return dir;
}
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');

/* --------------------------- 跑体检脚本 --------------------------- */
function run(dir, ...extra) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', dir, ...extra], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const dirs = [];
let pass = 0, fail = 0;
function expect(name, cond, detail) {
  if (cond) { pass++; console.log('OK    ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  ← ' + detail : '')); }
}

try {
  /* 1) 正常场景：所有检查项都应通过 */
  let d = fresh(); dirs.push(d);
  let r = run(d);
  expect('正常场景 exit 0 且报告体检通过',
    r.code === 0 && r.out.includes('体检通过'), `exit=${r.code}\n${r.out}`);

  /* 2) 版本不一致：manifest.json 版本改成 9.9.9 */
  d = fresh(); dirs.push(d);
  const mf = readJson(join(d, 'manifest.json')); mf.version = '9.9.9';
  writeJson(join(d, 'manifest.json'), mf);
  r = run(d);
  expect('版本不一致 → exit 1 且报「版本一致」',
    r.code === 1 && r.out.includes('[FAIL]') && r.out.includes('版本一致'), `exit=${r.code}\n${r.out}`);

  /* 3) 哈希错：build-info.json 里 edge 的 sha256 改坏 */
  d = fresh(); dirs.push(d);
  const infoPath = join(d, 'store/packages/build-info.json');
  const info = readJson(infoPath);
  info.packages.find(x => x.target === 'edge').sha256 = 'deadbeef'.repeat(8);
  writeJson(infoPath, info);
  r = run(d);
  expect('哈希错 → exit 1 且报「bytes / sha256」',
    r.code === 1 && r.out.includes('[FAIL]') && r.out.includes('bytes / sha256'), `exit=${r.code}\n${r.out}`);

  /* 4) 源码包混入 dist/：换一个含违规条目的 zip，并同步 build-info 与 README，
     让「源码包不含…」成为唯一失败项，证明该检查真的独立生效。 */
  d = fresh(); dirs.push(d);
  const srcFile = `mirror-fastlane-source-${V}.zip`;
  const oldInfo = readJson(join(d, 'store/packages/build-info.json'));
  const oldRec = oldInfo.packages.find(x => x.target === 'source');
  const badZip = makeZip([
    { name: `${SRC_PREFIX}/manifest.json`, data: Buffer.from(JSON.stringify({ version: V })) },
    { name: `${SRC_PREFIX}/dist/leak.txt`, data: Buffer.from('leak') },
  ]);
  const oldPrefix = oldRec.sha256.slice(0, 8);
  const newPrefix = sha256(badZip).slice(0, 8);
  writeFileSync(join(d, 'store/packages', srcFile), badZip);
  oldRec.bytes = badZip.length;
  oldRec.sha256 = sha256(badZip);
  writeJson(join(d, 'store/packages/build-info.json'), oldInfo);
  // README 里手抄的是旧前缀，同步改成新前缀，避免「README 前缀」先失败掩盖目标检查
  const rdPath = join(d, 'store/README.md');
  writeFileSync(rdPath, readFileSync(rdPath, 'utf8').replace(oldPrefix, newPrefix));
  r = run(d);
  expect('源码包含 dist/ → exit 1 且报「源码包不含」',
    r.code === 1 && r.out.includes('[FAIL]') && r.out.includes('源码包不含'), `exit=${r.code}\n${r.out}`);
  expect('源码包含 dist/ → 该检查是唯一失败项（哈希/README 已同步）',
    (r.out.match(/\[FAIL\]/g) || []).length === 1, r.out);

  /* 5) 清单 schema 坏：mirrors 置空 */
  d = fresh(); dirs.push(d);
  writeJson(join(d, 'data/builtin-mirrors.json'), { updated: '2026-11-08', mirrors: [] });
  r = run(d);
  expect('清单 schema 非法 → exit 1 且报「清单 schema」',
    r.code === 1 && r.out.includes('[FAIL]') && r.out.includes('清单 schema'), `exit=${r.code}\n${r.out}`);

  /* 6) 缺包：删掉 edge zip */
  d = fresh(); dirs.push(d);
  rmSync(join(d, 'store/packages', `mirror-fastlane-edge-${V}.zip`), { force: true });
  r = run(d);
  expect('缺少 edge zip → exit 1 且报「zip 存在」',
    r.code === 1 && r.out.includes('[FAIL]') && r.out.includes('zip 存在'), `exit=${r.code}\n${r.out}`);

  /* 7) --skip-packages：临时目录里即使删掉全部 zip 也只做版本 + 清单 */
  d = fresh(); dirs.push(d);
  for (const f of ['edge', 'firefox', 'source']) {
    rmSync(join(d, 'store/packages', `mirror-fastlane-${f}-${V}.zip`), { force: true });
  }
  r = run(d, '--skip-packages');
  expect('skip-packages 不碰 zip → exit 0',
    r.code === 0 && r.out.includes('项通过'), `exit=${r.code}\n${r.out}`);

} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log('临时目录已清理：' + dirs.every(d => !existsSync(d)));
process.exit(fail ? 1 : 0);
