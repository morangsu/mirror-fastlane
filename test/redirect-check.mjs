/* 端到端：验证 GitHub 下载请求真的被 DNR 改写到了镜像域名
 * 运行： node test/redirect-check.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXT = join(process.cwd(), 'dist', 'edge');
const PORT = 9347;
const NAMES = ['镜像快车道', 'Mirror Fastlane'];   // 名称已本地化，两种语言都认
const TARGET = 'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-pc-windows-msvc.zip.sha256';
const RAW_TARGET = 'https://raw.githubusercontent.com/morangsu/mirror-fastlane/main/data/builtin-mirrors.json';

const BIN = process.env.MFL_BIN || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'D:/scoop/apps/googlechrome/current/chrome.exe',
].find(existsSync);

const profile = mkdtempSync(join(tmpdir(), 'mfl-redir-'));
const dlDir = mkdtempSync(join(tmpdir(), 'mfl-dl-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const child = spawn(BIN, [
  `--user-data-dir=${profile}`, `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
  `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
  '--headless=new', 'about:blank',
], { stdio: 'ignore' });

function connect(url) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const events = [];
    s.addEventListener('open', () => resolve({
      events,
      call(m, p, sid) {
        return new Promise((res, rej) => {
          const i = ++id;
          pending.set(i, { res, rej });
          s.send(JSON.stringify(sid
            ? { id: i, method: m, params: p, sessionId: sid }
            : { id: i, method: m, params: p }));
        });
      },
      close: () => s.close(),
    }));
    s.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      } else if (m.method) {
        events.push(m);
      }
    });
    s.addEventListener('error', reject);
  });
}

let pass = 0, fail = 0;
const errs = [];
function ok(n, c, e) {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; errs.push(n + (e ? ' → ' + e : '')); console.log('  ✗', n, e || ''); }
}

const RE_GITHUB_RELEASE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//;

try {
  let ver = null;
  for (let i = 0; i < 60; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch {}
    await sleep(300);
  }
  const b = await connect(ver.webSocketDebuggerUrl);
  // 下载指到临时目录：这个测试会真的下载一个资产，别落到用户下载夹
  await b.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: false }).catch(() => {});
  await sleep(2500);

  const { targetInfos } = await b.call('Target.getTargets');
  let sw = null, session = null;
  for (const t of targetInfos.filter(x => x.type === 'service_worker' && x.url.startsWith('chrome-extension://'))) {
    const { sessionId } = await b.call('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    const r = await b.call('Runtime.evaluate', {
      expression: 'chrome.runtime.getManifest().name', returnByValue: true,
    }, sessionId).catch(() => null);
    if (r && r.result && NAMES.includes(r.result.value)) { sw = t; session = sessionId; break; }
  }
  ok('扩展已加载', !!sw);
  if (!sw) throw new Error('扩展未加载');

  const st = await b.call('Runtime.evaluate', {
    expression: `(async () => {
      const s = await handlers['get-state']();
      const m = s.mirrors.filter(x => x.enabled && x.healthy).sort((a, b) => (b.score || 0) - (a.score || 0))[0];
      return { host: m ? new URL(m.base).host : '', rules: (s.ruleInfo || {}).count };
    })()`,
    awaitPromise: true, returnByValue: true,
  }, session);
  const bestHost = st.result.value.host;
  console.log('  当前镜像:', bestHost, '| 规则数:', st.result.value.rules);
  ok('存在可用的最佳镜像', !!bestHost, JSON.stringify(st.result.value));
  ok('规则已生效', st.result.value.rules > 0, 'count=' + st.result.value.rules);

  const { targetId } = await b.call('Target.createTarget', { url: 'about:blank' });
  const { sessionId: ps } = await b.call('Target.attachToTarget', { targetId, flatten: true });
  await b.call('Network.enable', {}, ps);
  await b.call('Page.enable', {}, ps);

  await b.call('Page.navigate', { url: TARGET }, ps);
  await sleep(6000);

  const hits = b.events.filter(e => e.method === 'Network.requestWillBeSent' && e.sessionId === ps);

  const chains = new Map();
  for (const e of hits) {
    const id = e.params.requestId;
    if (!chains.has(id)) chains.set(id, []);
    chains.get(id).push({ url: e.params.request.url, redirected: !!e.params.redirectResponse });
  }

  console.log('  release 相关跳转链:');
  for (const [, chain] of chains) {
    if (!chain.some(x => x.url.includes('/releases/download/'))) continue;
    chain.forEach((x, i) => {
      console.log('    ' + (i ? '→ ' : '  ') + x.url.slice(0, 96) + (x.redirected ? '  [302]' : ''));
    });
  }

  const releaseChains = [...chains.values()].filter(c => c.some(x => x.url.includes('/releases/download/')));
  ok('存在 release 下载的请求链', releaseChains.length > 0, 'chains=' + releaseChains.length);

  const rewritten = releaseChains.find(c =>
    c.length >= 2 &&
    RE_GITHUB_RELEASE.test(c[0].url) &&
    !!bestHost && c.some(x => x.url.includes(bestHost)));

  ok('原始请求被重定向到镜像', !!rewritten, rewritten ? '' : '未找到 github → 镜像 的跳转链');

  if (rewritten) {
    const mirrorReq = rewritten.find(x => x.url.includes(bestHost));
    ok('镜像请求带 redirectResponse（确为改写而非另起请求）', mirrorReq.redirected === true);
    ok('改写形式为「镜像前缀 + 完整原链」',
      mirrorReq.url === 'https://' + bestHost + '/' + TARGET,
      mirrorReq.url.slice(0, 130));
    ok('跳转链首跳是 github 原链', RE_GITHUB_RELEASE.test(rewritten[0].url), rewritten[0].url.slice(0, 96));
  }

  /* raw 分片：导航到一个 raw 单文件，确认也被改写成「镜像前缀 + 原链」 */
  const { targetId: rawTarget } = await b.call('Target.createTarget', { url: 'about:blank' });
  const { sessionId: rs } = await b.call('Target.attachToTarget', { targetId: rawTarget, flatten: true });
  await b.call('Network.enable', {}, rs);
  await b.call('Page.enable', {}, rs);
  await b.call('Page.navigate', { url: RAW_TARGET }, rs);
  await sleep(6000);

  const rawChains = new Map();
  for (const e of b.events) {
    if (e.method !== 'Network.requestWillBeSent' || e.sessionId !== rs) continue;
    const id = e.params.requestId;
    if (!rawChains.has(id)) rawChains.set(id, []);
    rawChains.get(id).push({ url: e.params.request.url, redirected: !!e.params.redirectResponse });
  }
  const rawHit = [...rawChains.values()].find(c =>
    c.some(x => x.url === RAW_TARGET) &&
    c.some(x => x.url.includes('/https://raw.githubusercontent.com/')));
  // 默认没拿到 raw.githubusercontent.com 的可选权限：Chrome 不会应用重定向，扩展也不该注册空转规则。
  // 「加权限后会改写」由一次性验证脚本（review/verify-raw-e2e.mjs）实证，不进常驻测试。
  ok('raw 原始请求确实发出了',
    [...rawChains.values()].some(c => c.some(x => x.url === RAW_TARGET)), '未见 raw 请求');
  ok('未授权时 raw 不被改写（遵守 host 权限约束）', !rawHit, rawHit ? '出现了改写' : '');

  b.close();
} catch (e) {
  fail++;
  errs.push('致命: ' + (e && e.message ? e.message : e));
  console.log('  ✗ 致命:', e && e.message ? e.message : e);
} finally {
  try { child.kill(); } catch {}
  await sleep(800);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  try { rmSync(dlDir, { recursive: true, force: true }); } catch {}
}

console.log('\n' + '─'.repeat(46));
console.log(`通过 ${pass}  失败 ${fail}`);
if (fail) {
  console.log('\n失败项:');
  errs.forEach(e => console.log('  ✗ ' + e));
  process.exit(1);
}
console.log('全部通过');
process.exit(0);
