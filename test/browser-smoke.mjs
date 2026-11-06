/* 浏览器冒烟测试：在 Edge/Chromium 中加载扩展，通过 CDP 校验真实运行状态
 * 运行： node test/browser-smoke.mjs
 * 可选： MFL_BIN=<浏览器路径>
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'dist', 'edge');
const PORT = 9345;
// 名称已本地化（__MSG_extName__）：无头浏览器默认 en-US，中文环境是另一个值
const TARGET_NAMES = ['镜像快车道', 'Mirror Fastlane'];

const BIN = process.env.MFL_BIN || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'D:/scoop/apps/googlechrome/current/chrome.exe',
].find(existsSync);

if (!BIN) { console.error('找不到可加载扩展的浏览器'); process.exit(2); }

const profile = mkdtempSync(join(tmpdir(), 'mfl-smoke-'));
const dlDir = mkdtempSync(join(tmpdir(), 'mfl-dl-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const child = spawn(BIN, [
  `--user-data-dir=${profile}`,
  `--load-extension=${EXT}`,
  `--disable-extensions-except=${EXT}`,
  `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check',
  '--headless=new',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let stderr = '';
child.stderr.on('data', d => { stderr += d.toString(); });

function connect(url) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    s.addEventListener('open', () => resolve({
      call(method, params, sessionId) {
        return new Promise((res, rej) => {
          const i = ++id;
          pending.set(i, { res, rej });
          s.send(JSON.stringify(sessionId
            ? { id: i, method, params: params || {}, sessionId }
            : { id: i, method, params: params || {} }));
        });
      },
      close: () => s.close(),
    }));
    s.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      }
    });
    s.addEventListener('error', reject);
  });
}

let pass = 0, fail = 0;
const errs = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; errs.push(name + (extra ? ' → ' + extra : '')); console.log('  ✗', name, extra || ''); }
}

let browser = null;
try {
  let ver = null;
  for (let i = 0; i < 60; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch {}
    await sleep(300);
  }
  if (!ver) throw new Error('CDP 端口未就绪');
  console.log('浏览器:', ver.Browser);

  browser = await connect(ver.webSocketDebuggerUrl);
  await browser.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: false }).catch(() => {});
  await sleep(2200);

  // 找到我们扩展的 service worker（按 manifest 名匹配，避免撞到浏览器内置扩展）
  let target = null, extId = '';
  const { targetInfos } = await browser.call('Target.getTargets');
  for (const t of targetInfos.filter(x => x.type === 'service_worker' && x.url.startsWith('chrome-extension://'))) {
    try {
      const { sessionId } = await browser.call('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      const r = await browser.call('Runtime.evaluate', {
        expression: 'chrome.runtime.getManifest().name', returnByValue: true,
      }, sessionId).catch(() => null);
      if (r && r.result && TARGET_NAMES.includes(r.result.value)) {
        target = t; extId = new URL(t.url).host;
        var session = sessionId;
        break;
      }
    } catch {}
  }
  ok('扩展已成功加载', !!target, target ? 'id=' + extId : '未找到，浏览器可能禁用了 --load-extension');
  if (!target) throw new Error('扩展未加载，终止');

  const evalIn = async (expression) => {
    const r = await browser.call('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    }, session);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('JS 异常: ' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result.value;
  };

  /* 1. 共享逻辑注入 */
  ok('后台可访问 MFL 共享逻辑', await evalIn('typeof MFL === "object" && typeof MFL.buildRules === "function"'));

  /* 2. 默认设置与内置镜像 */
  const st = await evalIn(`(async () => {
    const s = await chrome.storage.local.get(['settings','mirrors','ruleInfo']);
    return { enabled: s.settings && s.settings.enabled,
             probeMode: s.settings && s.settings.probeMode,
             mirrors: (s.mirrors || []).length,
             rules: (s.ruleInfo || {}).count };
  })()`);
  ok('默认启用且探测模式为「仅按需」', st.enabled === true && st.probeMode === 'ondemand', JSON.stringify(st));
  ok('内置镜像已灌入（10 条）', st.mirrors === 10, 'mirrors=' + st.mirrors);

  /* 3. DNR 规则真实注册 */
  const rules = await evalIn(`(async () => {
    const rs = await chrome.declarativeNetRequest.getDynamicRules();
    rs.sort((a,b)=>b.priority-a.priority);
    return rs.map(r => ({ p: r.priority, f: r.condition.regexFilter, s: r.action.redirect.regexSubstitution, t: r.condition.resourceTypes }));
  })()`);
  ok('DNR 动态规则已注册', rules.length > 0, 'count=' + rules.length);
  ok('规则指向 release 下载路径', /releases\\?\/download/.test(rules[0].f), rules[0].f);
  ok('替换式 = 镜像前缀 + 整段原串', /^https:\/\/[^/]+\/\\0$/.test(rules[0].s), rules[0].s);
  ok('资源类型覆盖 main_frame（下载导航）', rules[0].t.includes('main_frame'), JSON.stringify(rules[0].t));
  ok('规则按优先级递减排序', rules.every((r, i) => i === 0 || r.p <= rules[i - 1].p), JSON.stringify(rules.map(r => r.p)));

  /* 4. 消息接口 */
  const state = await evalIn(`(async () => {
    const r = await handlers['get-state']();
    return { ok: !!r, mirrors: r && r.mirrors && r.mirrors.length, inWindow: r && r.inWindow };
  })()`);
  ok('内部消息 get-state 正常', state.ok === true && state.mirrors === 10, JSON.stringify(state));

  /* 5. 生成规则的纯函数与真实规则一致 */
  const consistency = await evalIn(`(async () => {
    const s = await chrome.storage.local.get(['settings','mirrors']);
    const built = MFL.buildRules(s.mirrors, s.settings);
    const live = await chrome.declarativeNetRequest.getDynamicRules();
    return { built: built.length, live: live.length };
  })()`);
  ok('重建逻辑与在线规则条数一致', consistency.built === consistency.live, JSON.stringify(consistency));

  /* 6. 关开关 -> 规则清空 */
  await evalIn(`handlers['save-settings']({ patch: { enabled: false } })`);
  await sleep(700);
  const off = await evalIn(`(async () => (await chrome.declarativeNetRequest.getDynamicRules()).length)()`);
  ok('关闭总开关后规则被清空（回退主站）', off === 0, 'count=' + off);

  await evalIn(`handlers['save-settings']({ patch: { enabled: true } })`);
  await sleep(700);
  const on = await evalIn(`(async () => (await chrome.declarativeNetRequest.getDynamicRules()).length)()`);
  ok('重新开启后规则恢复', on > 0, 'count=' + on);

  /* 7. 生效时段过滤 */
  const winTest = await evalIn(`(async () => {
    // 构造一个肯定不含当前时刻的窗口：上午用 20–22 点，下午用 02–04 点
    const h = new Date().getHours();
    const start = h < 12 ? '20:00' : '02:00';
    const end = h < 12 ? '22:00' : '04:00';
    await handlers['save-settings']({ patch: { activeWindow: { enabled: true, start, end } } });
    await new Promise(r => setTimeout(r, 600));
    const n = (await chrome.declarativeNetRequest.getDynamicRules()).length;
    await handlers['save-settings']({ patch: { activeWindow: { enabled: false, start:'20:00', end:'02:00' } } });
    await new Promise(r => setTimeout(r, 600));
    return { offWindow: n, restored: (await chrome.declarativeNetRequest.getDynamicRules()).length };
  })()`);
  ok('时段外不生成规则', winTest.offWindow === 0, JSON.stringify(winTest));
  ok('取消时段限制后规则恢复', winTest.restored > 0, JSON.stringify(winTest));

  /* 8. 设置页渲染 */
  await browser.call('Target.createTarget', { url: `chrome-extension://${extId}/options/options.html` });
  await sleep(1600);
  const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const optPage = pages.find(p => p.type === 'page' && p.url.includes('/options/options.html'));
  ok('设置页可打开', !!optPage);
  if (optPage) {
    const pc = await connect(optPage.webSocketDebuggerUrl);
    await pc.call('Runtime.enable');
    await sleep(1000);
    const v = (await pc.call('Runtime.evaluate', {
      expression: `(() => ({ rows: document.querySelectorAll('#mirrorBody tr').length,
        tag: (document.getElementById('ruleTag')||{}).textContent,
        info: (document.getElementById('ruleInfo')||{}).textContent,
        first: (document.querySelector('#mirrorBody tr')||{}).innerText || '' }))()`,
      returnByValue: true,
    })).result.value;
    ok('设置页渲染出 10 条镜像', v.rows === 10, 'rows=' + v.rows);
    ok('设置页显示规则状态', !!v.tag && v.tag !== '—', JSON.stringify(v).slice(0, 160));
    ok('首行含镜像域名', /https?|\./.test(v.first), v.first.replace(/\s+/g, ' ').slice(0, 80));
    pc.close();
  }

  /* 9. 校验页 SHA-256 */
  await browser.call('Target.createTarget', { url: `chrome-extension://${extId}/verify/verify.html` });
  await sleep(1400);
  const pages2 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const vPage = pages2.find(p => p.type === 'page' && p.url.includes('/verify/verify.html'));
  ok('校验页可打开', !!vPage);
  if (vPage) {
    const vc = await connect(vPage.webSocketDebuggerUrl);
    await vc.call('Runtime.enable');
    await sleep(700);
    const h = (await vc.call('Runtime.evaluate', {
      expression: `SHA256.hashText('abc')`, returnByValue: true, awaitPromise: true,
    })).result.value;
    ok('页面内 SHA-256 结果正确', h === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', String(h));
    vc.close();
  }

  /* 10. 弹窗页 */
  await browser.call('Target.createTarget', { url: `chrome-extension://${extId}/popup/popup.html` });
  await sleep(1200);
  const pages3 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pPage = pages3.find(p => p.type === 'page' && p.url.includes('/popup/popup.html'));
  ok('弹窗页可打开', !!pPage);
  if (pPage) {
    const pc2 = await connect(pPage.webSocketDebuggerUrl);
    await pc2.call('Runtime.enable');
    await sleep(800);
    const t = (await pc2.call('Runtime.evaluate', {
      expression: `(document.getElementById('best')||{}).textContent`, returnByValue: true,
    })).result.value;
    ok('弹窗显示当前镜像', !!t && t !== '—', String(t).slice(0, 60));
    pc2.close();
  }

  browser.close();
} catch (e) {
  fail++;
  errs.push('致命: ' + (e && e.message ? e.message : e));
  console.log('  ✗ 致命错误:', e && e.message ? e.message : e);
} finally {
  try { child.kill(); } catch {}
  await sleep(900);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

console.log('\n' + '─'.repeat(48));
console.log(`通过 ${pass}  失败 ${fail}`);
if (fail) {
  console.log('\n失败项:');
  errs.forEach(e => console.log('  ✗ ' + e));
  if (stderr) console.log('\n浏览器 stderr:\n' + stderr.slice(0, 1200));
  process.exit(1);
}
console.log('全部通过');
process.exit(0);
