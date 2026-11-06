/* 生成商店用截图：加载扩展 → 真实页面截图 → 1280×800 PNG
 * 运行： node tools/store-shots.mjs        （可选 MFL_BIN 指定浏览器）
 *
 * Edge 商店要求截图 1280×800 或 640×480，这里统一出 1280×800。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'dist', 'edge');
const OUT = join(ROOT, 'store', 'screenshots');
const PORT = 9346;
const W = 1280, H = 800;

const BIN = process.env.MFL_BIN || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'D:/scoop/apps/googlechrome/current/chrome.exe',
].find(existsSync);

if (!BIN) { console.error('找不到可加载扩展的浏览器'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'mfl-shots-'));
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

const plans = [
  { file: '01-overview.png', page: 'options/options.html', scrollTo: '', wait: 2600 },
  { file: '02-probe-window.png', page: 'options/options.html', scrollTo: '探测策略', wait: 2600 },
  { file: '03-hash.png', page: 'options/options.html', scrollTo: '哈希校验', wait: 2600 },
  { file: '04-verify.png', page: 'verify/verify.html', scrollTo: '', wait: 1600 },
];

let browser = null;
try {
  let ver = null;
  for (let i = 0; i < 60; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch {}
    await sleep(300);
  }
  if (!ver) throw new Error('CDP 端口未就绪');
  browser = await connect(ver.webSocketDebuggerUrl);
  await sleep(2400);

  // 找扩展 id
  let extId = '';
  const { targetInfos } = await browser.call('Target.getTargets');
  for (const t of targetInfos.filter(x => x.type === 'service_worker' && x.url.startsWith('chrome-extension://'))) {
    const m = /^chrome-extension:\/\/([a-p]+)\//.exec(t.url);
    if (!m) continue;
    const { sessionId } = await browser.call('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    const r = await browser.call('Runtime.evaluate', {
      expression: 'chrome.runtime.getManifest().name', returnByValue: true,
    }, sessionId).catch(() => null);
    if (r && r.result && ['镜像快车道', 'Mirror Fastlane'].includes(r.result.value)) { extId = m[1]; break; }
  }
  if (!extId) throw new Error('没找到扩展的 service worker');
  console.log('扩展 id:', extId);

  mkdirSync(OUT, { recursive: true });

  for (const p of plans) {
    const url = `chrome-extension://${extId}/${p.page}`;
    const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.call('Target.attachToTarget', { targetId, flatten: true });
    await browser.call('Page.enable', {}, sessionId);
    // 统一用浅色：商店里更易读，也和系统深色模式无关
    await browser.call('Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sessionId);
    await browser.call('Emulation.setDeviceMetricsOverride',
      { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);
    await browser.call('Page.navigate', { url }, sessionId);
    await sleep(p.wait);
    if (p.scrollTo) {
      // 滚到指定小节，比手调像素稳
      await browser.call('Runtime.evaluate', {
        expression: `(() => {
          const h = [...document.querySelectorAll('h2')].find(x => x.textContent.includes(${JSON.stringify(p.scrollTo)}));
          if (!h) return 'no-heading';
          h.scrollIntoView({ block: 'start' });
          window.scrollBy(0, -16);
          return String(Math.round(window.scrollY));
        })()`,
        returnByValue: true,
      }, sessionId);
      await sleep(500);
    }
    const shot = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
    const buf = Buffer.from(shot.data, 'base64');
    const file = join(OUT, p.file);
    writeFileSync(file, buf);
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    console.log(`[shot] ${file}  ${w}x${h}  ${(buf.length / 1024).toFixed(0)} KB`);
    if (w !== W || h !== H) console.log('  ⚠ 尺寸不是 1280×800');
    await browser.call('Target.closeTarget', { targetId });
  }

  browser.close();
} catch (e) {
  console.error('截图失败:', e && e.message ? e.message : e);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch {}
  await sleep(800);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
