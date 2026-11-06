/* 探测：扩展能否静默把一段文本写进浏览器下载目录
 * 这是「扩展写任务文件 → 脚本读并通知」方案的前提。
 * 分别测三条路径：data: URL / blob（需 offscreen）/ 扩展自身资源 URL
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = process.env.MFL_BIN || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'D:/scoop/apps/googlechrome/current/chrome.exe',
].find(p => p && existsSync(p));

const EXT = process.argv[2] || 'C:/Users/YI/AppData/Local/Temp/mfl-exp';
const PORT = 9499;
const PROFILE = mkdtempSync(join(tmpdir(), 'mfl-dl-'));
const DLDIR = mkdtempSync(join(tmpdir(), 'mfl-dlout-'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 用 profile 里的 Preferences 指定下载目录（比 CDP 的 setDownloadBehavior 更接近真实行为）
mkdirSync(join(PROFILE, 'Default'), { recursive: true });
writeFileSync(join(PROFILE, 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: DLDIR, prompt_for_download: false, directory_upgrade: true },
}), 'utf8');

const child = spawn(BIN, [
  `--user-data-dir=${PROFILE}`,
  `--load-extension=${EXT}`,
  `--disable-extensions-except=${EXT}`,
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
      call(method, params = {}, sessionId) {
        const mid = ++id;
        ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
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
    if (st.isDirectory()) {
      if (depth < 2) out.push(...listing(p, depth + 1));
    } else out.push({ path: p, size: st.size });
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

  await sleep(1500);
  const { targetInfos } = await browser.call('Target.getTargets');
  let sid = null;
  for (const t of targetInfos.filter(x => x.type === 'service_worker' && x.url.startsWith('chrome-extension://'))) {
    try {
      const { sessionId } = await browser.call('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      const r = await browser.call('Runtime.evaluate', {
        expression: 'chrome.runtime.getManifest().name', returnByValue: true,
      }, sessionId).catch(() => null);
      if (r && r.result && r.result.value === 'dl-probe') { sid = sessionId; break; }
    } catch { /* 跳过 */ }
  }
  if (!sid) throw new Error('未找到实验扩展');

  const evalIn = async expr => {
    const r = await browser.call('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    }, sid);
    if (r.exceptionDetails) {
      return { error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    }
    return r.result.value;
  };

  console.log('下载目录:', DLDIR);

  console.log('\n=== A. filename 是否可控（三种写法）===');
  const a = await evalIn(`(async () => {
    const mk = (obj) => {
      const bytes = new TextEncoder().encode(JSON.stringify(obj));
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return 'data:application/json;base64,' + btoa(bin);
    };
    const tries = [
      { label: '无子目录', filename: 'probe-plain.json' },
      { label: '带子目录', filename: '_mfl-tasks/probe-sub.json' },
      { label: '中文文件名', filename: '_mfl-tasks/任务-中文.json' },
    ];
    const out = [];
    for (const t of tries) {
      try {
        const id = await chrome.downloads.download({
          url: mk({ label: t.label, ts: Date.now() }),
          filename: t.filename, conflictAction: 'overwrite', saveAs: false,
        });
        out.push({ label: t.label, want: t.filename, id });
      } catch (e) {
        out.push({ label: t.label, want: t.filename, error: String(e && e.message || e) });
      }
    }
    return out;
  })()`);
  console.log('  ', JSON.stringify(a, null, 1));
  await sleep(3000);

  console.log('\n=== A2. https URL + filename（判断是否 data: 特例）===');
  const a2 = await evalIn(`(async () => {
    try {
      const id = await chrome.downloads.download({
        url: 'https://dns.google/resolve?name=example.com&type=A',
        filename: '_mfl-tasks/probe-https.json',
        conflictAction: 'overwrite', saveAs: false,
      });
      return { ok: true, id };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  })()`);
  console.log('  ', JSON.stringify(a2));
  await sleep(4000);

  console.log('\n=== B. 实际落地路径与状态 ===');
  const c = await evalIn(`(async () => {
    const items = await chrome.downloads.search({ limit: 10, orderBy: ['-startTime'] });
    return items.map(i => ({ id: i.id, file: i.filename, state: i.state, err: i.error || '' }));
  })()`);
  console.log('  ', JSON.stringify(c, null, 1));

  await sleep(1500);
  console.log('\n=== 落地文件 ===');
  const files = listing(DLDIR);
  if (!files.length) console.log('  （空）');
  for (const f of files) {
    console.log('  ' + f.path.replace(DLDIR, '').replace(/\\/g, '/') + '  ' + f.size + 'B');
    if (/\.json$/.test(f.path) && f.size < 500) {
      console.log('    内容: ' + readFileSync(f.path, 'utf8').slice(0, 120));
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
