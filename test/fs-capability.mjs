/* 验证 Service Worker 中的 File System Access 能力（OPFS 作为同套接口的代理指标） */
import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'D:/scoop/apps/googlechrome/current/chrome.exe'].find(existsSync);
const EXT = process.argv[2] || 'E:/WorkBuddy AI/richang/local/mirror-fastlane/dist/edge';
const PORT = 9451;
const PROFILE = mkdtempSync(join(tmpdir(), 'mfl-fs-'));

const proc = spawn(BIN, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  `--disable-extensions-except=${EXT}`,
  `--load-extension=${EXT}`,
  '--no-first-run', '--no-default-browser-check',
  '--headless=new',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let errText = '';
proc.stderr.on('data', d => { errText += d.toString(); });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const j = await r.json();
      if (j.length) return j;
    } catch { /* 尚未就绪 */ }
    await sleep(500);
  }
  throw new Error('DevTools 未就绪; stderr=' + errText.slice(0, 400));
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0;
    const wait = new Map();
    ws.onopen = () => res({
      call(method, params = {}, sessionId) {
        const mid = ++id;
        ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
        return new Promise((ok, no) => wait.set(mid, { ok, no }));
      },
      close: () => ws.close(),
    });
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && wait.has(m.id)) {
        const { ok, no } = wait.get(m.id);
        wait.delete(m.id);
        m.error ? no(new Error(m.error.message)) : ok(m.result);
      }
    };
    ws.onerror = () => rej(new Error('ws error'));
  });
}

let browser, wsUrl;
try {
  let v = null;
  for (let i = 0; i < 40 && !v; i++) {
    try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); }
    catch { await sleep(500); }
  }
  if (!v) throw new Error('端点未就绪; stderr=' + errText.slice(0, 300));
  wsUrl = v.webSocketDebuggerUrl;
  browser = await connect(wsUrl);

  const { targetInfos } = await browser.call('Target.getTargets');
  const sw = targetInfos.find(t => t.type === 'service_worker' && /chrome-extension:\/\//.test(t.url));
  if (!sw) { console.log('未找到扩展 service worker'); process.exit(1); }

  const { sessionId } = await browser.call('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  await browser.call('Runtime.enable', {}, sessionId);

  const probe = await browser.call('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const out = {};
      out.hasStorageManager = !!(self.navigator && navigator.storage && navigator.storage.getDirectory);
      out.hasFsHandleCtor = typeof FileSystemHandle !== 'undefined';
      out.hasDirHandleCtor = typeof FileSystemDirectoryHandle !== 'undefined';
      out.hasShowPicker = typeof self.showDirectoryPicker === 'function';
      out.hasIndexedDB = typeof indexedDB !== 'undefined';
      out.chromeDefined = typeof chrome !== 'undefined';\n      out.hasNotifications = typeof chrome !== 'undefined' && !!(chrome.notifications && chrome.notifications.create);

      // 1) SW 内能否用 FileSystemDirectoryHandle 读写
      try {
        const root = await navigator.storage.getDirectory();
        out.dirHandleOk = root instanceof FileSystemDirectoryHandle || typeof root.getFileHandle === 'function';
        const fh = await root.getFileHandle('probe.txt', { create: true });
        const w = await fh.createWritable();
        await w.write('hello-sw');
        await w.close();
        const f = await fh.getFile();
        out.readBack = await f.text();
        out.sizeOk = f.size === 8;
      } catch (e) { out.opfsError = String(e && e.message || e); }

      // 2) 索引库能否存/取 FileSystemHandle
      try {
        const db = await new Promise((ok, no) => {
          const r = indexedDB.open('mfl-probe', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('kv');
          r.onsuccess = () => ok(r.result);
          r.onerror = () => no(r.error);
        });
        const root2 = await navigator.storage.getDirectory();
        await new Promise((ok, no) => {
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(root2, 'handle');
          tx.oncomplete = ok; tx.onerror = () => no(tx.error);
        });
        const got = await new Promise((ok, no) => {
          const tx = db.transaction('kv', 'readonly');
          const rq = tx.objectStore('kv').get('handle');
          rq.onsuccess = () => ok(rq.result); rq.onerror = () => no(rq.error);
        });
        out.handleRoundTrip = !!(got && typeof got.getFileHandle === 'function');
        out.handleKind = got && got.kind;
      } catch (e) { out.idbError = String(e && e.message || e); }

      // 3) 权限查询方法存在性
      try {
        const root3 = await navigator.storage.getDirectory();
        out.hasQueryPermission = typeof root3.queryPermission === 'function';
        out.hasRequestPermission = typeof root3.requestPermission === 'function';
        if (out.hasQueryPermission) {
          out.permState = await root3.queryPermission({ mode: 'read' });
        }
      } catch (e) { out.permError = String(e && e.message || e); }

      return out;
    })()`,
  }, sessionId);

  if (probe.exceptionDetails) {
    console.log('!!! 探测异常:', JSON.stringify(probe.exceptionDetails, null, 1).slice(0, 900));
  }
  const r = probe.result.value || {};
  console.log('=== Service Worker 内的文件系统能力 ===');
  for (const [k, v] of Object.entries(r)) {
    console.log(`  ${k.padEnd(22)} ${JSON.stringify(v)}`);
  }
} finally {
  try { browser && browser.close(); } catch { }
  proc.kill();
  await sleep(600);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch { }
}
