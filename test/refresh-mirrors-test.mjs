/* tools/refresh-mirrors.mjs 回归测试
 *   - 手工精选（无 auto）永不删；auto:true 的条目由源决定去留
 *   - 规范化 / 去重 / status 空白 / 空源拒绝覆盖 / 无变化不写 / --replace
 * 运行：node test/refresh-mirrors-test.mjs
 * 全部写临时目录（--out），不碰仓库里的 data/builtin-mirrors.json。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'tools', 'refresh-mirrors.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'mfl-refresh-'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name); } };
const eq = (name, got, want) => ok(name + ' → got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want),
  JSON.stringify(got) === JSON.stringify(want));

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const rd = p => JSON.parse(readFileSync(p, 'utf8'));
const bases = p => rd(p).mirrors.map(m => m.base);

/* ------------------------------ 1. 合并语义 ------------------------------ */
const out1 = join(TMP, 'out1.json');
writeFileSync(out1, JSON.stringify({
  updated: '2026-01-01',
  note: 'seed',
  mirrors: [
    { name: 'C1', base: 'https://c1.example', seedKbps: 100 },
    { name: 'C2', base: 'https://c2.example' },
    { name: 'A1', base: 'https://a1.example', auto: true },
    { name: 'A2', base: 'https://a2.example', auto: true },
  ],
}, null, 2));

const src1 = join(TMP, 'src1.json');
writeFileSync(src1, JSON.stringify({
  data: [
    { name: 'A1', url: 'https://a1.example', status: 'SUCCESS ' },   // 带空白也要认
    { name: 'N1', url: 'https://n1.example/some/path', status: 'success' }, // 带路径 → 规范成 host
    { name: 'N1dup', url: 'https://n1.example', status: 'success' },        // 同 host 去重
    { name: 'dead', url: 'https://dead.example', status: 'fail' },          // 非 success 丢弃
  ],
}, null, 2));

let r = run(['--from', src1, '--out', out1]);
eq('合并：退出码 0', r.code, 0);
eq('合并：精选保留 + auto 被源撤下 + 新项加入',
  bases(out1), ['https://c1.example', 'https://c2.example', 'https://a1.example', 'https://n1.example']);
eq('合并：精选原有字段保留', rd(out1).mirrors[0].seedKbps, 100);
ok('合并：源加进来的条目标 auto', rd(out1).mirrors[3].auto === true);
ok('合并：源撤下的 auto 条目已移除', !bases(out1).includes('https://a2.example'));
ok('合并：非 success 项被丢弃', !bases(out1).includes('https://dead.example'));
eq('合并：重复 host 只留一条', bases(out1).filter(b => b === 'https://n1.example').length, 1);
ok('合并：路径被截断成根地址', bases(out1).includes('https://n1.example'));

/* -------------------- 1.5 源换了地址：新地址覆盖旧地址 -------------------- */
const out1b = join(TMP, 'out1b.json');
writeFileSync(out1b, JSON.stringify({
  updated: '2026-01-01',
  note: 'seed',
  mirrors: [
    { name: 'C1', base: 'https://c1.example' },
    { name: 'M', base: 'https://old.example', auto: true },
  ],
}, null, 2));
const src1b = join(TMP, 'src1b.json');
writeFileSync(src1b, JSON.stringify({ data: [{ name: 'M', url: 'https://new.example', status: 'success' }] }, null, 2));

r = run(['--from', src1b, '--out', out1b]);
eq('换地址：退出码 0', r.code, 0);
eq('换地址：旧地址被新地址覆盖', bases(out1b), ['https://c1.example', 'https://new.example']);
eq('换地址：新条目自动标 auto', rd(out1b).mirrors[1].auto, true);
ok('换地址：统计里算「移除 1」', /移除 1/.test(r.out));

/* ---------------- 1.6 源的顺序即文件顺序（整段覆盖，不是拼接） ---------------- */
const out1c = join(TMP, 'out1c.json');
writeFileSync(out1c, JSON.stringify({
  mirrors: [
    { name: 'B', base: 'https://b.example', auto: true },
    { name: 'A', base: 'https://a.example', auto: true },
  ],
}, null, 2));
const src1c = join(TMP, 'src1c.json');
writeFileSync(src1c, JSON.stringify({
  data: [
    { name: 'A', url: 'https://a.example', status: 'success' },
    { name: 'B', url: 'https://b.example', status: 'success' },
  ],
}, null, 2));

r = run(['--from', src1c, '--out', out1c]);
eq('整段覆盖：顺序跟随源', bases(out1c), ['https://a.example', 'https://b.example']);
ok('整段覆盖：保留原有条目的其它字段', rd(out1c).mirrors[0].name === 'A');

/* --------------------------- 2. 无变化不写文件 --------------------------- */
const before = readFileSync(out1, 'utf8');
r = run(['--from', src1, '--out', out1]);
eq('无变化：退出码 0', r.code, 0);
ok('无变化：提示跳过', /无变化/.test(r.out));
eq('无变化：文件字节未变', readFileSync(out1, 'utf8'), before);

/* ----------------------------- 3. 空源拒绝 ----------------------------- */
const emptySrc = join(TMP, 'empty.json');
writeFileSync(emptySrc, JSON.stringify({ data: [] }));
const beforeEmpty = readFileSync(out1, 'utf8');
r = run(['--from', emptySrc, '--out', out1]);
ok('空源：非零退出', r.code !== 0);
ok('空源：提示拒绝写入', /拒绝写入/.test(r.out));
eq('空源：原文件保持不变', readFileSync(out1, 'utf8'), beforeEmpty);

/* ------------------------- 4. 全失败也算空源 ------------------------- */
const failSrc = join(TMP, 'fail.json');
writeFileSync(failSrc, JSON.stringify({ data: [{ name: 'x', url: 'https://x.example', status: 'fail' }] }));
r = run(['--from', failSrc, '--out', out1]);
ok('全失败：非零退出', r.code !== 0);
eq('全失败：原文件保持不变', readFileSync(out1, 'utf8'), beforeEmpty);

/* ---------------------------- 5. --replace ---------------------------- */
const out2 = join(TMP, 'out2.json');
writeFileSync(out2, JSON.stringify({ mirrors: [{ name: 'C1', base: 'https://c1.example' }] }, null, 2));
r = run(['--from', src1, '--out', out2, '--replace']);
eq('replace：退出码 0', r.code, 0);
ok('replace：精选被丢弃', !bases(out2).includes('https://c1.example'));
eq('replace：只剩源数据', bases(out2).sort(), ['https://a1.example', 'https://n1.example']);

/* --------------------------- 6. 参数缺失报错 --------------------------- */
r = run(['--from']);
ok('--from 缺参数：非零退出', r.code !== 0);
ok('--from 缺参数：明确报错', /--from 后面要跟/.test(r.out));

/* ------------------------------ 7. --dry ------------------------------ */
const out3 = join(TMP, 'out3.json');
r = run(['--from', src1, '--out', out3, '--dry']);
eq('dry：退出码 0', r.code, 0);
ok('dry：不创建文件', !existsSync(out3));
ok('dry：输出可用 JSON', (() => { try { JSON.parse(r.out.split('\n[dry]')[0]); return true; } catch { return false; } })());

rmSync(TMP, { recursive: true, force: true });

console.log('────────────────────────────────────────────────────');
console.log(`通过 ${pass}  失败 ${fail}`);
if (fail) process.exit(1);
console.log('全部通过');
