/* 浏览器冒烟测试：在 Edge/Chromium 中加载扩展，通过 CDP 校验真实运行状态
 * 运行： node test/browser-smoke.mjs
 * 可选： MFL_BIN=<浏览器路径>
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'dist', 'edge');
// 内置清单条数会随仓库里的清单变化（Action 每天更新），断言按文件实际条数来，别写死
const BUILTIN_COUNT = JSON.parse(readFileSync(join(ROOT, 'data', 'builtin-mirrors.json'), 'utf8')).mirrors.length;
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

// CI（Linux 容器）需要的额外开关：
//  - no-sandbox / disable-dev-shm-usage：容器里没有 namespace 与足够 /dev/shm
//  - DisableLoadExtensionCommandLineSwitch：Chrome 137+ 默认忽略 --load-extension，
//    关掉这个特性才能继续用命令行加载扩展（Chrome for Testing 默认就允许）
const CI_FLAGS = process.env.CI ? [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
] : [];

const child = spawn(BIN, [
  `--user-data-dir=${profile}`,
  `--load-extension=${EXT}`,
  `--disable-extensions-except=${EXT}`,
  `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check',
  '--headless=new',
  ...CI_FLAGS,
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
  ok('扩展已成功加载', !!target, target ? 'id=' + extId
    : '未找到。Chrome 137+ 默认忽略 --load-extension，需用 Chrome for Testing 或加 --disable-features=DisableLoadExtensionCommandLineSwitch');
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
  ok('内置镜像已灌入（' + BUILTIN_COUNT + ' 条）', st.mirrors === BUILTIN_COUNT, 'mirrors=' + st.mirrors);

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

  // raw 规则默认不生成（需要 raw.githubusercontent.com 的可选权限，headless 里拿不到）。
  // 这里直接检查「Chromium 是否接受这些分片正则」：手动注册一次，读回来再恢复。
  const rawCheck = await evalIn(`(async () => {
    const mirrors = (await chrome.storage.local.get('mirrors')).mirrors || [];
    const settings = Object.assign({}, MFL.DEFAULT_SETTINGS, { raw: { enabled: true } });
    const rules = MFL.buildRules(mirrors, settings, { rawAllowed: true }).filter(r => r.priority === 95);
    try {
      const cur = await chrome.declarativeNetRequest.getDynamicRules();
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: cur.map(r => r.id), addRules: rules });
      const after = await chrome.declarativeNetRequest.getDynamicRules();
      const raw = after.filter(r => r.priority === 95);
      const hosts = [...new Set(raw.map(r => (String(r.action.redirect.regexSubstitution).match(/^https:\\/\\/([^/]+)\\//) || [])[1]))];
      return { built: rules.length, applied: raw.length, types: raw.map(r => r.condition.resourceTypes), hosts };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    } finally {
      try { await handlers['apply'](); } catch {}
    }
  })()`);
  ok('raw 分片规则能被 Chromium 接受', rawCheck && rawCheck.applied === 5, JSON.stringify(rawCheck));
  ok('raw 规则只作用于 main_frame',
    rawCheck && rawCheck.types && rawCheck.types.every(t => t.length === 1 && t[0] === 'main_frame'),
    JSON.stringify(rawCheck && rawCheck.types));
  ok('raw 分片分散到多个镜像（不是全压一个）',
    rawCheck && rawCheck.hosts && new Set(rawCheck.hosts).size >= 3, JSON.stringify(rawCheck && rawCheck.hosts));
  ok('拿到权限前默认不生成 raw 规则', rules.filter(r => r.p === 95).length === 0, JSON.stringify(rules.map(r => r.p)));

  /* 4. 消息接口 */
  const state = await evalIn(`(async () => {
    const r = await handlers['get-state']();
    return { ok: !!r, mirrors: r && r.mirrors && r.mirrors.length, inWindow: r && r.inWindow };
  })()`);
  ok('内部消息 get-state 正常', state.ok === true && state.mirrors === BUILTIN_COUNT, JSON.stringify(state));

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

  /* 7a. 规则被外部清空后必须自愈（指纹只证明「要的没变」，不证明「规则还在」） */
  const heal = await evalIn(`(async () => {
    const before = (await chrome.declarativeNetRequest.getDynamicRules()).length;
    const cur = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: cur.map(r => r.id), addRules: [] });
    const emptied = (await chrome.declarativeNetRequest.getDynamicRules()).length;
    await applyRules(false);
    const after = (await chrome.declarativeNetRequest.getDynamicRules()).length;
    return { before, emptied, after };
  })()`);
  ok('规则被外部清空后，指纹路径能自愈',
    heal.emptied === 0 && heal.after === heal.before, JSON.stringify(heal));

  /* 7b. 并发写入串行化：探测几十秒后不能拿旧快照回滚用户操作 */
  const race = await evalIn(`(async () => {
    const before = await getMirrors();
    const id = before[0].id;
    const wasEnabled = before[0].enabled;
    const wasNote = before[0].note || '';
    const slow = mutateMirrors(list => new Promise(res => setTimeout(
      () => res(list.map(m => m.id === id ? Object.assign({}, m, { note: 'slow-write' }) : m)), 120)));
    await new Promise(r => setTimeout(r, 20));
    const fast = mutateMirrors(list => list.map(
      m => m.id === id ? Object.assign({}, m, { enabled: false }) : m));
    await Promise.all([slow, fast]);
    const after = await getMirrors();
    const m = after.find(x => x.id === id);
    const out = { note: m && m.note, enabled: m && m.enabled, count: after.length };
    // 还原现场，别影响后面的断言
    await mutateMirrors(list => list.map(x => x.id === id
      ? Object.assign({}, x, { enabled: wasEnabled, note: wasNote }) : x));
    return out;
  })()`);
  ok('并发写入互不覆盖（慢写 + 快写都保留）',
    race.note === 'slow-write' && race.enabled === false, JSON.stringify(race));

  /* 7c. 内置清单补齐：老用户升级能补到新条目，但手动删掉的不复活 */
  const seedHeal = await evalIn(`(async () => {
    const all = await getMirrors();
    const b = all.find(m => m.source === 'builtin');
    const before = all.length;
    // 1) 模拟「装的时候只有旧清单」：直接删一条内置（不记墓碑）
    await mutateMirrors(list => list.filter(m => m.id !== b.id));
    const afterDel = (await getMirrors()).length;
    await seedMirrors();
    const afterSeed = (await getMirrors()).length;
    const back = (await getMirrors()).some(m => m.id === b.id);
    // 2) 走 handler 删除（会记墓碑）→ 补齐不应复活
    await handlers['remove-mirror']({ id: b.id, base: b.base });
    const afterTomb = (await getMirrors()).length;
    await seedMirrors();
    const stayed = !(await getMirrors()).some(m => m.id === b.id);
    // 3) 清理墓碑并补齐，恢复原状
    await chrome.storage.local.remove('removedBuiltin');
    await seedMirrors();
    const restored = (await getMirrors()).length;
    return { before, afterDel, afterSeed, back, afterTomb, stayed, restored };
  })()`);
  ok('缺失的内置镜像会被补齐', seedHeal.afterSeed === seedHeal.before && seedHeal.back, JSON.stringify(seedHeal));
  ok('用户手动删掉的内置镜像不会被补齐复活', seedHeal.stayed, JSON.stringify(seedHeal));
  ok('清掉墓碑后清单恢复原条数', seedHeal.restored === seedHeal.before, JSON.stringify(seedHeal));

  /* 7d. 一键自检：分级结果 + 可复制文本 */
  const chk = await evalIn(`(async () => {
    const r = await handlers['self-check']();
    return r && r.check ? { items: r.check.items, text: r.check.text } : null;
  })()`);
  ok('自检返回分级结果',
    !!(chk && Array.isArray(chk.items) && chk.items.length >= 3 && /\[(OK|WARN|FAIL)\]/.test(chk.text)),
    chk ? chk.text.split('\n').slice(0, 2).join(' | ') : 'null');
  ok('自检结果包含可用镜像与规则两类结论',
    !!(chk && chk.text.includes('镜像') && chk.text.includes('规则')),
    chk ? chk.text.slice(0, 100) : 'null');

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
        first: (document.querySelector('#mirrorBody tr')||{}).innerText || '',
        uiRaw: !!document.getElementById('rawStatsInfo'),
        uiDiag: !!document.getElementById('diagExport'),
        rawA: !!document.getElementById('rawEnabled'),
        rawB: !!document.getElementById('rawEnabled2'),
        rawSame: (document.getElementById('rawEnabled')||{}).checked ===
                 (document.getElementById('rawEnabled2')||{}).checked,
        selfCheckBtn: !!document.getElementById('selfCheck'),
        i18nCount: document.querySelectorAll('[data-i18n]').length,
        title: (document.querySelector('h1')||{}).textContent || '' }))()`,
      returnByValue: true,
    })).result.value;
    ok('设置页渲染出 ' + BUILTIN_COUNT + ' 条镜像', v.rows === BUILTIN_COUNT, 'rows=' + v.rows);
    ok('设置页显示规则状态', !!v.tag && v.tag !== '—', JSON.stringify(v).slice(0, 160));
    ok('首行含镜像域名', /https?|\./.test(v.first), v.first.replace(/\s+/g, ' ').slice(0, 80));
    ok('raw 统计与诊断导出按钮都在', v.uiRaw && v.uiDiag, JSON.stringify({ uiRaw: v.uiRaw, uiDiag: v.uiDiag }));
    ok('raw 两个开关都在且状态一致',
      v.rawA && v.rawB && v.rawSame,
      JSON.stringify({ a: v.rawA, b: v.rawB, same: v.rawSame }));
    ok('设置页有一键自检按钮', v.selfCheckBtn, String(v.selfCheckBtn));
    ok('设置页关键标签已挂双语字典', v.i18nCount >= 30 && TARGET_NAMES.includes(v.title),
      JSON.stringify({ count: v.i18nCount, title: v.title }));

    // 回归：连续勾选「启用哈希校验」+「自动记录」，两个开关必须同时为 true。
    // 以前第二次点击会用页面里过期的 state 拼 patch，把第一次的 enabled 覆盖回 false。
    const hashMerge = (await pc.call('Runtime.evaluate', {
      expression: `(async () => {
        window.ensureApiPermission = async () => true;
        await toggleHashFlag('enabled', { checked: true });
        await toggleHashFlag('auto', { checked: true });
        const s = await chrome.runtime.sendMessage({ type: 'get-state' });
        return s.settings.hash;
      })()`,
      returnByValue: true, awaitPromise: true,
    })).result.value;
    ok('连续勾选两个哈希开关后同时生效',
      !!(hashMerge && hashMerge.enabled && hashMerge.auto), JSON.stringify(hashMerge));

    // 回归：重新加载解包扩展会清空 storage，用户常以为开关还开着。
    // 「一键开启」必须一次把两个开关都打开，并把 checkbox / 状态条同步刷新。
    const oneClick = (await pc.call('Runtime.evaluate', {
      expression: `(async () => {
        await chrome.runtime.sendMessage({ type: 'save-settings', patch: { hash: { enabled: false, auto: false } } });
        window.ensureApiPermission = async () => true;
        document.getElementById('enableAutoHash').click();
        await new Promise(r => setTimeout(r, 900));
        const s = await chrome.runtime.sendMessage({ type: 'get-state' });
        return { hash: s.settings.hash,
                 tag: (document.getElementById('hashStatusTag')||{}).textContent,
                 cb1: document.getElementById('hashEnabled').checked,
                 cb2: document.getElementById('hashAuto').checked };
      })()`,
      returnByValue: true, awaitPromise: true,
    })).result.value;
    ok('一键开启同时打开两个哈希开关',
      !!(oneClick && oneClick.hash && oneClick.hash.enabled && oneClick.hash.auto), JSON.stringify(oneClick));
    ok('一键开启后两个 checkbox 同步打勾',
      !!(oneClick && oneClick.cb1 && oneClick.cb2), JSON.stringify(oneClick));
    ok('自动校验状态条已刷新',
      !!(oneClick && ['已就绪', '未就绪'].includes(oneClick.tag)), JSON.stringify(oneClick && oneClick.tag));
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
