/* 验证：IDM 扩展在场时，data: URL 的下载会不会被劫持
 * 静态证据已表明 IDM 只认 http/https/ftp/ftps；这里做动态确认。
 * 同时对照 https / blob 两条路径。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = process.env.MFL_BIN || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
// 本机相关路径一律由环境变量提供；未设置时退化成「纯对照」模式，不读任何个人目录
const PROBE_EXT = process.env.MFL_PROBE_EXT || join(tmpdir(), 'mfl-exp2');
const IDM_EXT = process.env.MFL_IDM_EXT || '';
const LOAD_IDM = process.argv.includes('--with-idm') && existsSync(IDM_EXT);

const PORT = 9503;
const PROFILE = mkdtempSync(join(tmpdir(), 'mfl-idm-'));
const DLDIR = mkdtempSync(join(tmpdir(), 'mfl-idmout-'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

mkdirSync(join(PROFILE, 'Default'), { recursive: true });
writeFileSync(join(PROFILE, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: DLDIR, prompt_for_download: false } }), 'utf8');

const extList = LOAD_IDM ? `${PROBE_EXT},${IDM_EXT}` : PROBE_EXT;
const child = spawn(BIN, [
  `--user-data-dir=${PROFILE}`,
  `--load-extension=${extList}`,
  `--disable-extensions-except=${extList}`,
  `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check',
  '--headless=new', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let err = '';
child.stderr.on('data', d => { err += d.toString(); });

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0;
    const wait = new Map();
    ws.onopen = () => res({
      call(m, p = {}, s) {
        const mid = ++id;
        ws.send(JSON.stringify({ id: mid, method: m, params: p, sessionId: s }));
        return new Promise((o, n) => wait.set(mid, { o, n }));
      },
      close: () => ws.close(),
    });
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && wait.has(m.id)) {
        const { o, n } = wait.get(m.id);
        wait.delete(m.id);
        m.error ? n(new Error(m.error.message)) : o(m.result);
      }
    };
    ws.onerror = () => rej(new Error('ws error'));
  });
}

function listing(dir, depth = 0) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) { if (depth < 2) out.push(...listing(p, depth + 1)); }
    else out.push({ path: p.replace(dir, ''), size: st.size });
  }
  return out;
}

let browser;
try {
  let ver = null;
  for (let i = 0; i < 40 && !ver; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); }
    catch { await sleep(500); }
  }
  if (!ver) throw new Error('CDP 未就绪: ' + err.slice(0, 200));
  browser = await connect(ver.webSocketDebuggerUrl);
  await sleep(2000);

  const { targetInfos } = await browser.call('Target.getTargets');

  // MV2 扩展的后台是常驻页面（background_page），不是 service_worker，必须按扩展 ID 判断
  const IDM_ID = process.env.MFL_IDM_ID || '';
  const idmTargets = IDM_ID ? targetInfos.filter(t => (t.url || '').includes(IDM_ID)) : [];
  const sws = targetInfos.filter(x => x.type === 'service_worker' && x.url.startsWith('chrome-extension://'));

  console.log('加载 IDM 扩展:', LOAD_IDM ? '是' : '否（纯对照）');
  console.log('全部 target:');
  for (const t of targetInfos) {
    console.log(`  ${String(t.type).padEnd(18)} ${(t.url || '').slice(0, 90)}`);
  }
  console.log('\nIDM 相关 target 数:', idmTargets.length, idmTargets.map(t => t.type).join(',') || '(无)');

  const names = [];
  let sid = null;
  for (const t of sws) {
    try {
      const { sessionId } = await browser.call('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      const r = await browser.call('Runtime.evaluate', {
        expression: 'chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().name : "?"',
        returnByValue: true,
      }, sessionId).catch(() => null);
      const n = r && r.result && r.result.value;
      if (n) {
        names.push(n);
        if (n === 'fs-probe') sid = sessionId;
      }
    } catch { /* 跳过 */ }
  }
  console.log('已加载扩展:', names.join(' | ') || '(无)');
  const idmLoaded = idmTargets.length > 0 || names.some(n => /IDM|Download/i.test(n));
  console.log('IDM 扩展是否加载成功:', idmLoaded ? '是' : '否');
  if (!sid) throw new Error('探测扩展未加载');

  const evalIn = async expr => {
    const r = await browser.call('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    }, sid);
    if (r.exceptionDetails) {
      return { __error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    }
    return r.result.value;
  };

  console.log('\n=== 触发三种下载 ===');
  const res = await evalIn(`(async () => {
    const enc = (o) => {
      const b = new TextEncoder().encode(JSON.stringify(o));
      let s = ''; for (const x of b) s += String.fromCharCode(x);
      return 'data:application/json;base64,' + btoa(s);
    };
    const out = {};

    // 1) data: URL —— 我们要用的方式
    try {
      out.dataUrl = await chrome.downloads.download({
        url: enc({ kind: 'data', at: Date.now() }),
        filename: '_mfl-probe/data.json',
        conflictAction: 'overwrite', saveAs: false,
      });
    } catch (e) { out.dataUrl = 'ERR: ' + String(e && e.message || e); }

    // 2) blob: URL —— 备用方式
    try {
      const blob = new Blob([JSON.stringify({ kind: 'blob', at: Date.now() })], { type: 'application/json' });
      const u = URL.createObjectURL(blob);
      out.blobUrl = await chrome.downloads.download({
        url: u, filename: '_mfl-probe/blob.json',
        conflictAction: 'overwrite', saveAs: false,
      });
      out.blobRevoked = typeof URL.revokeObjectURL === 'function';
    } catch (e) { out.blobUrl = 'ERR: ' + String(e && e.message || e); }

    // 3) https URL —— 正向对照，证明 downloads 本身能用
    try {
      out.httpsUrl = await chrome.downloads.download({
        url: 'https://www.example.com/favicon.ico',
        filename: '_mfl-probe/https.ico',
        conflictAction: 'overwrite', saveAs: false,
      });
    } catch (e) { out.httpsUrl = 'ERR: ' + String(e && e.message || e); }

    return out;
  })()`);
  console.log('  ' + JSON.stringify(res, null, 1));

  await sleep(5000);

  console.log('\n=== 下载记录状态（被劫持会显示 interrupted 或消失）===');
  const rec = await evalIn(`(async () => {
    const items = await chrome.downloads.search({ limit: 20 });
    return items.map(i => ({
      file: String(i.filename).split(/[\\\\/]/).pop(),
      state: i.state, paused: i.paused, err: i.error || '',
      byExt: i.byExtensionId ? i.byExtensionId.slice(0, 8) : '',
    }));
  })()`);
  console.log('  ' + JSON.stringify(rec, null, 1));

  console.log('\n=== 落地文件 ===');
  const files = listing(DLDIR);
  if (!files.length) console.log('  （空）');
  for (const f of files) {
    console.log(`  ${f.path}  ${f.size}B`);
    if (/\.json$/.test(f.path) && f.size < 300) {
      console.log('    内容: ' + readFileSync(join(DLDIR, f.path), 'utf8').slice(0, 120));
    }
  }
} catch (e) {
  console.error('异常:', e.message);
} finally {
  try { browser && browser.close(); } catch { }
  child.kill();
  await sleep(600);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch { }
  try { rmSync(DLDIR, { recursive: true, force: true }); } catch { }
}
