/* 探测：扩展到底能往磁盘写什么
 * 分四类验证：downloads API 的边界、File System Access 的可用性、
 * 扩展专属文件 API 是否存在、写入是否需要用户手势。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = process.env.MFL_BIN || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'D:/scoop/apps/googlechrome/current/chrome.exe',
].find(p => p && existsSync(p));

const EXT = process.env.MFL_PROBE_EXT || join(tmpdir(), 'mfl-exp2');
const PORT = 9501;
const PROFILE = mkdtempSync(join(tmpdir(), 'mfl-fs2-'));
const DLDIR = mkdtempSync(join(tmpdir(), 'mfl-fs2out-'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

mkdirSync(join(PROFILE, 'Default'), { recursive: true });
writeFileSync(join(PROFILE, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: DLDIR, prompt_for_download: false } }), 'utf8');

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
    const events = [];
    ws.onopen = () => res({
      events,
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
      } else if (m.method) events.push(m);
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
  await sleep(1500);

  const { targetInfos } = await browser.call('Target.getTargets');
  let sid = null, extId = '';
  for (const t of targetInfos.filter(x => x.type === 'service_worker' && x.url.startsWith('chrome-extension://'))) {
    try {
      const { sessionId } = await browser.call('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      const r = await browser.call('Runtime.evaluate', {
        expression: 'chrome.runtime.getManifest().name', returnByValue: true,
      }, sessionId).catch(() => null);
      if (r && r.result && r.result.value === 'fs-probe') { sid = sessionId; extId = new URL(t.url).host; break; }
    } catch { /* skip */ }
  }
  if (!sid) throw new Error('未找到实验扩展');

  const evalIn = async (expr, session = sid) => {
    const r = await browser.call('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    }, session);
    if (r.exceptionDetails) {
      return { __error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    }
    return r.result.value;
  };

  console.log('下载目录:', DLDIR, '\n');

  console.log('=== 1. downloads API 能否越界写 ===');
  const r1 = await evalIn(`(async () => {
    const mk = (o) => {
      const b = new TextEncoder().encode(JSON.stringify(o));
      let s = ''; for (const x of b) s += String.fromCharCode(x);
      return 'data:application/json;base64,' + btoa(s);
    };
    const out = [];
    const cases = [
      { label: '正常相对路径',   filename: 'ok/ok.json' },
      { label: '上跳 ..',        filename: '../escape.json' },
      { label: '多级上跳',       filename: '../../escape2.json' },
      { label: '绝对盘符',       filename: 'E:\\\\abs-test.json' },
      { label: '绝对 UNC',       filename: '\\\\\\\\server\\\\share\\\\x.json' },
      { label: '系统目录',       filename: 'C:/Windows/Temp/evil.json' },
    ];
    for (const c of cases) {
      try {
        const id = await chrome.downloads.download({
          url: mk({ probe: c.label, ts: Date.now() }),
          filename: c.filename, conflictAction: 'overwrite', saveAs: false,
        });
        out.push({ label: c.label, filename: c.filename, ok: true, id });
      } catch (e) {
        out.push({ label: c.label, filename: c.filename, ok: false, error: String(e && e.message || e).slice(0, 90) });
      }
    }
    return out;
  })()`);
  (r1 || []).forEach(x => {
    console.log(`  ${x.ok ? '接受' : '拒绝'}  ${x.label.padEnd(12)} ${x.filename}`);
    if (x.error) console.log(`         → ${x.error}`);
  });
  await sleep(2500);

  console.log('\n=== 2. 扩展专属文件 API 是否存在 ===');
  const r2 = await evalIn(`JSON.stringify({
    'chrome.fileSystem': typeof chrome.fileSystem,
    'chrome.fileSystemProvider': typeof chrome.fileSystemProvider,
    'chrome.downloads': typeof chrome.downloads,
    'chrome.offscreen': typeof chrome.offscreen,
    'showSaveFilePicker(自页面)': '见下一项',
    'navigator.storage.getDirectory': typeof (navigator.storage && navigator.storage.getDirectory),
    'FileSystemWritableFileStream': typeof FileSystemWritableFileStream
  })`);
  console.log('  ' + r2);

  console.log('\n=== 3. 页面上下文里的文件选择器 ===');
  const { targetId } = await browser.call('Target.createTarget', { url: `chrome-extension://${extId}/page.html` });
  const { sessionId: ps } = await browser.call('Target.attachToTarget', { targetId, flatten: true });
  await browser.call('Runtime.enable', {}, ps);
  await sleep(800);
  const r3 = await evalIn(`JSON.stringify({
    showSaveFilePicker: typeof window.showSaveFilePicker,
    showDirectoryPicker: typeof window.showDirectoryPicker,
    showOpenFilePicker: typeof window.showOpenFilePicker,
    hasFocus: document.hasFocus(),
    userActivation: navigator.userActivation ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive } : 'n/a'
  })`, ps);
  console.log('  ' + r3);

  console.log('\n=== 4. 无用户手势时能否写（OPFS 对照）===');
  const r4 = await evalIn(`(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle('gesture.txt', { create: true });
      if (!fh.createWritable) return { writable: false, note: 'handle 无 createWritable' };
      const w = await fh.createWritable();
      await w.write('no-gesture-ok');
      await w.close();
      const f = await fh.getFile();
      return { writable: true, content: await f.text(), size: f.size };
    } catch (e) { return { writable: false, error: String(e && e.message || e) }; }
  })()`, ps);
  console.log('  ' + JSON.stringify(r4));

  console.log('\n=== 5. 落地情况 ===');
  const files = listing(DLDIR);
  if (!files.length) console.log('  （下载目录内无文件）');
  for (const f of files) console.log(`  ${f.path}  ${f.size}B`);

  console.log('\n=== 6. 下载记录状态 ===');
  const r6 = await evalIn(`(async () => {
    const items = await chrome.downloads.search({ limit: 10 });
    return items.map(i => ({ id: i.id, file: i.filename.split('\\\\').pop(), state: i.state, err: i.error || '' }));
  })()`);
  console.log('  ' + JSON.stringify(r6, null, 1));
} catch (e) {
  console.error('异常:', e.message);
} finally {
  try { browser && browser.close(); } catch { }
  child.kill();
  await sleep(600);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch { }
  try { rmSync(DLDIR, { recursive: true, force: true }); } catch { }
}
