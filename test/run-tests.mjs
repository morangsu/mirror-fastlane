/* 测试：纯逻辑 + 清单完整性 + 合规扫描。运行： node test/run-tests.mjs */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const coreMod = await import('../lib/core.js');
await import('../lib/sha256.js');
const ahMod = await import('../lib/auto-hash.js');
const ghMod = await import('../lib/gh-hash.js');

const MFL = coreMod.default || globalThis.MFL;
const SHA256 = globalThis.SHA256;
const AH = ahMod.default || globalThis.AH;
const GHH = ghMod.default || globalThis.GHH;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (extra ? '  →  ' + extra : ''));
}
function eq(name, actual, expected) {
  ok(name, actual === expected, 'got=' + JSON.stringify(actual) + ' want=' + JSON.stringify(expected));
}
function group(title) { console.log('\n' + title); }

/* ------------------------------ 1. SHA-256 ------------------------------ */

group('1. SHA-256');
const VECTORS = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ['The quick brown fox jumps over the lazy dog',
    'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'],
];
for (const [input, want] of VECTORS) {
  eq('向量 "' + (input.slice(0, 18) || '(空)') + '"', SHA256.hashText(input), want);
}

// 分块一致性：随机长度切片累加，结果必须与一次性相同
const big = 'x'.repeat(100000);
const oneShot = SHA256.hashText(big);
const h = SHA256.create();
let idx = 0;
const sizes = [1, 7, 63, 64, 65, 127, 1000];
let s = 0;
while (idx < big.length) {
  const n = sizes[s++ % sizes.length];
  h.update(new TextEncoder().encode(big.slice(idx, idx + n)));
  idx += n;
}
eq('分块累加结果一致', h.hex(), oneShot);

/* ---------------------------- 2. 地址规范化 ---------------------------- */

group('2. 地址规范化');
eq('裸域名补协议', MFL.normalizeBase('ghfast.top'), 'https://ghfast.top');
eq('带尾斜杠', MFL.normalizeBase('https://ghfast.top/'), 'https://ghfast.top');
eq('带路径被截断', MFL.normalizeBase('https://ghfast.top/abc/def'), 'https://ghfast.top');
eq('大写协议', MFL.normalizeBase('HTTPS://GHFAST.TOP'), 'https://ghfast.top');
eq('http 被拒绝', MFL.normalizeBase('http://ghfast.top'), null);
eq('无点域名被拒绝', MFL.normalizeBase('localhost'), null);
eq('空值', MFL.normalizeBase('   '), null);
eq('host 提取', MFL.hostOf('https://ghfast.top'), 'ghfast.top');
eq('origin 模式', MFL.originPattern('https://ghfast.top'), 'https://ghfast.top/*');

/* ---------------------------- 3. 生效时段 ---------------------------- */

group('3. 生效时段');
const win = { enabled: true, start: '20:00', end: '02:00' };
eq('19:59 时段外', MFL.isWithinWindow(win, 19 * 60 + 59), false);
eq('20:00 时段内', MFL.isWithinWindow(win, 20 * 60), true);
eq('23:30 时段内', MFL.isWithinWindow(win, 23 * 60 + 30), true);
eq('01:00 跨天仍在内', MFL.isWithinWindow(win, 60), true);
eq('02:00 边界外', MFL.isWithinWindow(win, 120), false);
const day = { enabled: true, start: '09:00', end: '18:00' };
eq('同日 12:00 在内', MFL.isWithinWindow(day, 12 * 60), true);
eq('同日 18:00 在外', MFL.isWithinWindow(day, 18 * 60), false);
eq('未启用时永远在内', MFL.isWithinWindow({ enabled: false }, 3 * 60), true);
eq('非法时间视为在内', MFL.isWithinWindow({ enabled: true, start: 'xx', end: 'yy' }, 0), true);

/* ---------------------------- 4. 规则与替换 ---------------------------- */

group('4. DNR 规则');
const mirrors = [
  { id: 'a', name: 'A', base: 'https://a.example.com', enabled: true, healthy: true, permitted: true, score: 0.5 },
  { id: 'b', name: 'B', base: 'https://b.example.com', enabled: true, healthy: true, permitted: true, score: 0.9 },
  { id: 'c', name: 'C', base: 'https://c.example.com', enabled: false, healthy: true, permitted: true, score: 1 },
  { id: 'd', name: 'D', base: 'https://d.example.com', enabled: true, healthy: false, permitted: true, score: 1 },
  { id: 'e', name: 'E', base: 'https://e.example.com', enabled: true, healthy: true, permitted: false, score: 0.1 },
];
const rules = MFL.buildRules(mirrors, { codeload: { enabled: false }, split: { enabled: true } });
eq('只建一条直链规则（DNR 没有链式回退，多建的规则永远轮不到）', rules.length, 1);
eq('最高分镜像胜出', MFL.hostOf(rules[0].action.redirect.regexSubstitution), 'b.example.com');

const sample = 'https://github.com/obsproject/obs-studio/releases/download/33.0.1/OBS-Studio-33.0.1-macOS-Apple.dmg';
const r0 = rules[0];
const rewritten = MFL.applyRegexSubstitution(r0.condition.regexFilter, r0.action.redirect.regexSubstitution, sample);
eq('release 链接替换结果', rewritten, 'https://b.example.com/' + sample);

ok('非 release 链接不匹配',
  MFL.applyRegexSubstitution(r0.condition.regexFilter, r0.action.redirect.regexSubstitution,
    'https://github.com/owner/repo') === null);
ok('已是镜像的链接不匹配',
  MFL.applyRegexSubstitution(r0.condition.regexFilter, r0.action.redirect.regexSubstitution,
    'https://b.example.com/' + sample) === null);

const pick = MFL.chooseMirrors(mirrors, { split: { enabled: true } });
eq('首选是得分最高的健康镜像', pick.primary.id, 'b');
eq('分流时源码包换另一个镜像', pick.archive.id, 'a');
ok('停用与不健康的镜像不参与',
  pick.ranked.every(m => m.id !== 'c' && m.id !== 'd'), pick.ranked.map(m => m.id).join(','));
ok('未授权但健康的镜像仍可作为改写目标',
  pick.ranked.some(m => m.id === 'e'), pick.ranked.map(m => m.id).join(','));

const single = MFL.chooseMirrors(
  [{ id: 'x', base: 'https://x.example.com', enabled: true, healthy: true, score: 1 }],
  { split: { enabled: true } });
eq('只有一个镜像时分流退化为同一个', single.archive.id, 'x');

const withCodeload = MFL.buildRules(mirrors, { codeload: { enabled: true }, split: { enabled: true } });
eq('开启源码包后两条规则', withCodeload.length, 2);
const codeloadRule = withCodeload.find(r => r.condition.regexFilter.includes('codeload'));
eq('源码包走第二个镜像', MFL.hostOf(codeloadRule.action.redirect.regexSubstitution), 'a.example.com');
ok('直链优先级高于源码包', withCodeload[0].priority > codeloadRule.priority);
eq('规则 id 唯一', new Set(withCodeload.map(r => r.id)).size, 2);
const archiveUrl = 'https://codeload.github.com/owner/repo/tar.gz/refs/tags/v1.0.0';
eq('源码包替换结果',
  MFL.applyRegexSubstitution(codeloadRule.condition.regexFilter, codeloadRule.action.redirect.regexSubstitution, archiveUrl),
  'https://a.example.com/' + archiveUrl);

const noSplit = MFL.buildRules(mirrors, { codeload: { enabled: true }, split: { enabled: false } });
eq('关闭分流时源码包也走主镜像',
  MFL.hostOf(noSplit.find(r => r.condition.regexFilter.includes('codeload')).action.redirect.regexSubstitution),
  'b.example.com');
eq('无可用镜像时返回空规则', MFL.buildRules([], {}).length, 0);
eq('没有可用镜像时不选任何目标', MFL.chooseMirrors([], {}).primary, null);

/* ------------------------------ 5. 打分 ------------------------------ */

group('5. 打分');
const scored = MFL.scoreMirrors([
  { id: '1', stats: { kbps: 200, ttfb: 100 } },
  { id: '2', stats: { kbps: 100, ttfb: 100 } },
  { id: '3', stats: { kbps: 100, ttfb: 400 } },
]);
ok('吞吐高的分更高', scored[0].score > scored[1].score);
ok('延迟低的分更高', scored[1].score > scored[2].score);
const noStats = MFL.scoreMirrors([{ id: 'a', stats: { kbps: 0, ttfb: 0 } }, { id: 'b', stats: { kbps: 0, ttfb: 0 } }]);
ok('未测速时按顺序给分', noStats[0].score > noStats[1].score);

/* ------------------------------ 6. 探测判定 ------------------------------ */

group('6. 探测判定');
eq('正常', MFL.evaluateProbe({ status: 206, bytes: 262144, kbps: 300 }).ok, true);
eq('200 也算正常', MFL.evaluateProbe({ status: 200, bytes: 262144, kbps: 300 }).ok, true);
eq('429 失败', MFL.evaluateProbe({ status: 429, bytes: 0, kbps: 0 }).ok, false);
eq('过慢失败', MFL.evaluateProbe({ status: 206, bytes: 262144, kbps: 5 }).ok, false);
eq('空响应失败', MFL.evaluateProbe({ status: 206, bytes: 0, kbps: 0 }).ok, false);
eq('超时失败', MFL.evaluateProbe({ error: true, reason: 'timeout' }).reason, 'timeout');

/* ------------------------------ 7. outbox ------------------------------ */

group('7. outbox');
const H = 'a'.repeat(64);
const line1 = 'D:\\Downloads\\a.zip|' + H + '|ok|1000';
const p1 = MFL.parseOutboxLine(line1);
eq('路径解析', p1.path, 'D:\\Downloads\\a.zip');
eq('文件名解析', p1.name, 'a.zip');
eq('状态解析', p1.status, 'ok');
eq('秒级时间戳自动换算成毫秒', p1.ts, 1000000);
eq('毫秒时间戳原样保留', MFL.parseOutboxLine('x|' + 'a'.repeat(64) + '|ok|1700000000000').ts, 1700000000000);
eq('注释被忽略', MFL.parseOutboxLine('# hello'), null);
eq('哈希非法被拒绝', MFL.parseOutboxLine('x|notahash|ok|1'), null);
eq('字段不足被拒绝', MFL.parseOutboxLine('x|y'), null);

// 第 5 段可信度：旧记录没有这一段时留空，新记录带标签
eq('旧记录无可信度字段', MFL.parseOutboxLine('x|' + 'a'.repeat(64) + '|ok|1700000000000').trust, '');
eq('可信度 pass 被解析', MFL.parseOutboxLine('x|' + 'a'.repeat(64) + '|ok|1700000000000|pass').trust, 'pass');
eq('可信度 pass-unverified 被解析',
  MFL.parseOutboxLine('x|' + 'a'.repeat(64) + '|ok|1700000000000|pass-unverified').trust, 'pass-unverified');
eq('可信度 conflict 被解析', MFL.parseOutboxLine('x|' + 'a'.repeat(64) + '|ok|1700000000000|conflict').trust, 'conflict');
eq('乱写的可信度被丢弃', MFL.parseOutboxLine('x|' + 'a'.repeat(64) + '|ok|1700000000000|trusted').trust, '');

const merged = MFL.mergeOutbox([
  'D:\\d\\a.zip|' + 'b'.repeat(64) + '|ok|100',
  'D:\\d\\a.zip|' + 'c'.repeat(64) + '|fail|200',
  'D:\\d\\b.zip|' + 'd'.repeat(64) + '|ok|150',
], 10);
eq('同路径保留最新', merged.find(e => e.name === 'a.zip').ts, 200000);
eq('不同文件分别保留', merged.length, 2);
eq('按时间倒序', merged[0].ts, 200000);

const trimmed = MFL.trimOutbox([
  'D:\\d\\old.zip|' + H + '|ok|1',
  'D:\\d\\new.zip|' + H + '|ok|' + Date.now(),
], { max: 200, keepMs: 7 * 24 * 3600 * 1000 });
eq('过期记录被清理', trimmed.length, 1);

/* ------------------------------ 8. URL 解析 ------------------------------ */

group('8. URL 解析');
const rel = MFL.parseReleaseUrl('https://github.com/obsproject/obs-studio/releases/tag/33.0.1');
eq('owner', rel.owner, 'obsproject');
eq('repo', rel.repo, 'obs-studio');
eq('tag', rel.tag, '33.0.1');
eq('非 release 页返回 null', MFL.parseReleaseUrl('https://github.com/obsproject/obs-studio'), null);
eq('取文件名', MFL.fileNameFromUrl('https://x/y/OBS-Studio-33.0.1.dmg'), 'OBS-Studio-33.0.1.dmg');
eq('校验值前缀剥离', MFL.stripSha256Prefix('sha256:' + H), H);
eq('校验值合法判断', MFL.isValidSha256(H), true);
eq('校验值长度不足', MFL.isValidSha256('abc'), false);

// 下载直链里的 tag 必须留住，否则会退化成"最新版"，老版本被拿新版的哈希去比
const dl = MFL.parseReleaseUrl('https://github.com/o/r/releases/download/v1.0.0/foo-1.0.0.zip');
eq('直链 owner', dl.owner, 'o');
eq('直链保留 tag', dl.tag, 'v1.0.0');
eq('直链标记为 download', dl.kind, 'download');
const dlLatest = MFL.parseReleaseUrl('https://github.com/o/r/releases/latest/download/foo.zip');
eq('latest 直链 tag 为空', dlLatest.tag, null);
eq('latest 直链标记为 download', dlLatest.kind, 'download');
eq('页面 URL 标记为 page', rel.kind, 'page');
eq('latest 页面可识别',
  MFL.parseReleaseUrl('https://github.com/o/r/releases/latest') !== null, true);
eq('含斜杠的 tag 也能还原',
  MFL.parseReleaseUrl('https://github.com/o/r/releases/download/release/1.0/a.zip').tag, 'release/1.0');

/* ----------------------- 8.5 期望哈希的资产定位 ----------------------- */

group('8.5 资产定位');

// 用一个假的 fetch 路由，验证"认 tag"和"拒绝猜"这两件事
const realFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  const json = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (u.includes('/releases/tags/v1.0.0')) {
    return json({
      tag_name: 'v1.0.0',
      assets: [
        { id: 101, name: 'foo-1.0.0.zip', size: 1234, digest: 'sha256:' + H },
        { id: 102, name: 'foo-1.0.0.zip.sha256', size: 90, digest: 'sha256:' + 'b'.repeat(64) },
      ],
    });
  }
  if (u.includes('/releases/tags/v2.0.0')) {
    return json({ tag_name: 'v2.0.0', assets: [{ id: 201, name: 'foo-2.0.0.zip', size: 4321, digest: 'sha256:' + 'c'.repeat(64) }] });
  }
  if (u.includes('/releases?per_page=')) {
    return json([{ tag_name: 'v2.0.0', assets: [{ id: 201, name: 'foo-2.0.0.zip', size: 4321, digest: 'sha256:' + 'c'.repeat(64) }] }]);
  }
  return { ok: false, status: 404, json: async () => null, text: async () => '' };
};

try {
  const r1 = await GHH.resolveExpected('https://github.com/o/r/releases/download/v1.0.0/foo-1.0.0.zip', '', MFL);
  eq('老版本直链取到的是该 tag 的哈希', r1.hash, H);
  eq('回源锚点带 tag', r1.tag, 'v1.0.0');
  eq('回源锚点带资产 id', r1.assetId, 101);
  eq('回源锚点带字节数', r1.size, 1234);
  ok('查的是 /releases/tags/v1.0.0 而不是最新版',
    calls.some(u => u.includes('/releases/tags/v1.0.0')) && !calls.some(u => u.includes('per_page')),
    calls.join(' | '));

  const r2 = await GHH.resolveExpected('https://github.com/o/r/releases/tag/v2.0.0', '', MFL);
  eq('单个资产的页面可以定位', r2.hash, 'c'.repeat(64));

  let e1 = null;
  try { await GHH.resolveExpected('https://github.com/o/r/releases/tag/v1.0.0', '', MFL); } catch (e) { e1 = e; }
  ok('多资产页面拒绝瞎猜', !!e1 && /2 个资产/.test(e1.message), e1 && e1.message);

  let e2 = null;
  try { await GHH.resolveExpected('https://github.com/o/r/releases/download/v1.0.0/nope.zip', '', MFL); } catch (e) { e2 = e; }
  ok('文件名对不上时明确报错', !!e2 && /没有名为 nope\.zip/.test(e2.message), e2 && e2.message);
} finally {
  globalThis.fetch = realFetch;
}

/* --------------------------- 9. 清单与文件完整性 --------------------------- */

group('9. 清单与文件');
const mf = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
eq('manifest_version', mf.manifest_version, 3);
// 名称/简介走 _locales，商店才能识别出「简体中文」这个可选语言
eq('名称走本地化占位符', mf.name, '__MSG_extName__');
eq('简介走本地化占位符', mf.description, '__MSG_extDescription__');
eq('声明 default_locale', mf.default_locale, 'en');

const locDir = join(ROOT, '_locales');
const locales = existsSync(locDir) ? readdirSync(locDir).filter(n => statSync(join(locDir, n)).isDirectory()) : [];
ok('至少中英两套文案', locales.includes('zh_CN') && locales.includes('en'), locales.join(','));
for (const loc of ['zh_CN', 'en']) {
  const msgPath = join(locDir, loc, 'messages.json');
  if (!existsSync(msgPath)) { ok(`${loc} 有 messages.json`, false); continue; }
  const msg = JSON.parse(readFileSync(msgPath, 'utf8'));
  ok(`${loc} 有 extName / extDescription`,
    !!(msg.extName && msg.extName.message && msg.extDescription && msg.extDescription.message));
  ok(`${loc} 的简介不超过 132 字符（商店上限）`,
    (msg.extDescription.message || '').length <= 132,
    String((msg.extDescription.message || '').length));
}
ok('同时声明 service_worker 与 scripts',
  !!(mf.background && mf.background.service_worker && Array.isArray(mf.background.scripts)));
ok('Firefox 必填 data_collection_permissions',
  mf.browser_specific_settings && mf.browser_specific_settings.gecko &&
  mf.browser_specific_settings.gecko.data_collection_permissions.required[0] === 'none');
ok('有 gecko.id', !!(mf.browser_specific_settings && mf.browser_specific_settings.gecko.id));
ok('gecko.id 是正式 id（不是 example.com 占位）',
  /^[a-z0-9-]+@morangsu\.github\.io$/.test(
    (mf.browser_specific_settings.gecko.id || '')),
  mf.browser_specific_settings.gecko.id);
ok('声明 DNR 权限', mf.permissions.includes('declarativeNetRequest'));
ok('镜像域名走 optional', Array.isArray(mf.optional_host_permissions) && mf.optional_host_permissions.length > 0);
ok('未申请 tabs/webRequest 等敏感权限',
  !mf.permissions.includes('tabs') && !mf.permissions.includes('webRequest') && !mf.permissions.includes('clipboardRead'));

const refs = [];
const bgScripts = mf.background.scripts || [];
bgScripts.forEach(s => refs.push(s));
refs.push(mf.background.service_worker);
refs.push(mf.action.default_popup);
refs.push(mf.options_ui.page);
(mf.content_scripts || []).forEach(cs => { (cs.js || []).forEach(s => refs.push(s)); (cs.css || []).forEach(s => refs.push(s)); });
Object.values(mf.icons || {}).forEach(s => refs.push(s));
refs.push('data/builtin-mirrors.json');

for (const r of [...new Set(refs)]) {
  ok('文件存在: ' + r, existsSync(join(ROOT, r)));
}

/* ------------------------------ 10. 合规扫描 ------------------------------ */

group('10. 合规扫描');
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === 'dist' || n === 'node_modules' || n === '.git') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const files = walk(ROOT).filter(f => /\.(js|html|json|mjs)$/.test(f));

const bad = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  if (/\beval\s*\(/.test(src)) bad.push([f, 'eval']);
  if (/new\s+Function\s*\(/.test(src)) bad.push([f, 'new Function']);
  if (/<script[^>]+src\s*=\s*["']https?:/i.test(src)) bad.push([f, '远程脚本']);
  if (/github_pat_[A-Za-z0-9_]{20,}/.test(src)) bad.push([f, '疑似硬编码 Token']);
  if (/ghp_[A-Za-z0-9]{30,}/.test(src)) bad.push([f, '疑似硬编码经典 Token']);
  if (/document\.write\s*\(/.test(src)) bad.push([f, 'document.write']);
}
ok('无远程代码 / eval / 硬编码 Token', bad.length === 0, JSON.stringify(bad));

// 哈希功能依赖 api.github.com 的权限；设置页必须自己申请，否则任务文件里永远没有 expected
const optJs = readFileSync(join(ROOT, 'options', 'options.js'), 'utf8');
ok('设置页会为哈希功能申请 api.github.com 权限',
  /api\.github\.com\/\*/.test(optJs) && /permissions\.request/.test(optJs));
ok('manifest 未申请 tabs / webRequest 等宽权限',
  !JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')).permissions
    .some(p => ['tabs', 'webRequest', 'history', 'cookies'].includes(p)));

/* ------------------------------ 11. 打包产物 ------------------------------ */

group('11. 自动校验逻辑');
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const now = Date.now();

eq('文件名规范化忽略大小写', AH.normName('  Foo.ZIP '), 'foo.zip');
eq('从地址推文件名', AH.nameFromUrl('https://github.com/o/r/releases/download/v1/x.zip'), 'x.zip');
eq('地址非法时返回空', AH.nameFromUrl('not a url'), '');

const e1 = { name: 'x.zip', path: 'D:/a/x.zip', hash: H1, status: 'ok', ts: now - 1000 };
const e2 = { name: 'y.zip', path: 'D:/a/y.zip', hash: H2, status: 'ok', ts: now };
eq('条目键由路径与时间组成', AH.entryKey(e1), 'D:/a/x.zip|' + (now - 1000));

const fresh = AH.freshEntries([AH.entryKey(e2)], [e1, e2]);
eq('只返回新出现的条目', fresh.length, 1);
eq('新条目就是 e1', fresh[0].path, 'D:/a/x.zip');
eq('全部已见时返回空', AH.freshEntries([AH.entryKey(e1), AH.entryKey(e2)], [e1, e2]).length, 0);

const ver = AH.verifiable([e1, { path: 'p', hash: null, status: 'ok', ts: now }, { path: 'q', hash: H1, status: 'fail', ts: now }]);
eq('只保留成功且有哈希的条目', ver.length, 1);

let intents = [];
intents = AH.pushIntent(intents, { url: 'https://github.com/o/r/releases/download/v1/x.zip' }, now);
eq('意图里自动补上文件名', intents[0].name, 'x.zip');
eq('意图数量为 1', intents.length, 1);

intents = AH.pushIntent(intents, { url: 'https://github.com/o/r/releases/download/v1/x.zip' }, now + 10);
eq('同名再次点击不重复入队', intents.length, 1);
eq('同一文件保留最新时间', intents[0].ts, now + 10);

const m = AH.matchIntent(intents, 'X.ZIP', now + 20);
ok('匹配忽略大小写', !!m && m.name === 'x.zip');
eq('不相关文件不匹配', AH.matchIntent(intents, 'nope.zip', now + 20), null);
eq('超过 24 小时的意图不参与', AH.matchIntent(intents, 'x.zip', now + 25 * 3600 * 1000), null);

const many = [];
for (let i = 0; i < 80; i++) many.push({ url: 'https://github.com/o/r/releases/download/v1/f' + i + '.zip', name: 'f' + i + '.zip', ts: now });
eq('意图列表限长', AH.pushIntent(many, many[0], now).length, AH.MAX_INTENTS);

let results = [];
for (let i = 0; i < 25; i++) results = AH.pushResult(results, { name: 'f' + i, ok: true, ts: now + i });
eq('结果只保留最近 20 条', results.length, AH.MAX_RESULTS);
eq('结果按新到旧排列', results[0].name, 'f24');

eq('成功+有哈希+有意图 → 校验', AH.decide(e1, intents, now + 20).action, 'verify');
eq('下载失败 → 跳过', AH.decide({ name: 'x.zip', path: 'p', hash: H1, status: 'fail', ts: now }, intents, now).reason, 'download-failed');
eq('无哈希 → 跳过', AH.decide({ name: 'x.zip', path: 'p', hash: '', status: 'ok', ts: now }, intents, now).reason, 'no-hash');
eq('哈希格式不对 → 跳过', AH.decide({ name: 'x.zip', path: 'p', hash: 'xyz', status: 'ok', ts: now }, intents, now).reason, 'no-hash');
eq('找不到对应下载意图 → 跳过', AH.decide(e1, [], now).reason, 'no-intent');

/* 校验文件解析 */
eq('单值边车文件', GHH.parseChecksumText(H1 + '\n', 'whatever.zip'), H1);
eq('清单取匹配行', GHH.parseChecksumText(H1 + '  a.zip\n' + H2 + '  b.zip', 'b.zip'), H2);
eq('清单支持星号前缀', GHH.parseChecksumText(H1 + ' *c.zip', 'c.zip'), H1);
eq('清单不匹配返回 null', GHH.parseChecksumText(H1 + '  a.zip', 'zzz.zip'), null);
eq('空文本返回 null', GHH.parseChecksumText('', 'a.zip'), null);

group('12. 构建产物');
const edgeMf = join(ROOT, 'dist/edge/manifest.json');
const ffMf = join(ROOT, 'dist/firefox/manifest.json');
if (existsSync(edgeMf) && existsSync(ffMf)) {
  const em = JSON.parse(readFileSync(edgeMf, 'utf8'));
  const fm = JSON.parse(readFileSync(ffMf, 'utf8'));
  ok('edge 不含 browser_specific_settings', !em.browser_specific_settings);
  ok('firefox 不含 minimum_chrome_version', !fm.minimum_chrome_version);
  ok('firefox 保留 data_collection_permissions',
    !!(fm.browser_specific_settings && fm.browser_specific_settings.gecko.data_collection_permissions));
  ok('edge 图标已生成', existsSync(join(ROOT, 'dist/edge/icons/icon128.png')));
} else {
  ok('构建产物存在（先运行 node build.mjs）', false, '未找到 dist/');
}

/* -------------------------------- 汇总 -------------------------------- */

console.log('\n' + '─'.repeat(52));
console.log(`通过 ${pass}  失败 ${fail}`);
if (fail) {
  console.log('\n失败项：');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过');
