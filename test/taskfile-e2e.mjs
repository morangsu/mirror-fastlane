/* 端到端：扩展点击下载时能否写出校验任务文件
 * 运行： node test/taskfile-e2e.mjs
 * 注意：会写入浏览器真实下载目录，测试后自动清理。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'dist', 'edge');
const PORT = 9379;
const BIN = process.env.MFL_BIN || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'D:/scoop/apps/googlechrome/current/chrome.exe',
].find(p => p && existsSync(p));

const KEEP = process.argv.includes('--keep');   // 保留产物，供脚本联调
const TEST_NAME = 'mfl-selftest.zip';
const TEST_URL = 'https://github.com/o/r/releases/download/v1/mfl-selftest.zip';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✓ ' + n); return; }
  fail++; failures.push(n + (e ? ' → ' + e : '')); console.log('  ✗ ' + n + (e ? ' → ' + e : ''));
};
const eq = (n, a, b) => ok(n, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));

const profile = mkdtempSync(join(tmpdir(), 'mfl-task-'));
const child = spawn(BIN, [
  `--user-data-dir=${profile}`,
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

function findTaskFile(dir, depth = 0) {
  if (!existsSync(dir) || depth > 3) return null;
  const target = join(dir, '_mfl-tasks');
  if (existsSync(target)) {
    const f = join(target, TEST_NAME + '.task.json');
    if (existsSync(f)) return f;
  }
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    try {
      if (statSync(p).isDirectory()) {
        const r = findTaskFile(p, depth + 1);
        if (r) return r;
      }
    } catch { /* 跳过 */ }
  }
  return null;
}

let browser;
let taskPath = null;
try {
  let ver = null;
  for (let i = 0; i < 40 && !ver; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); }
    catch { await sleep(500); }
  }
  if (!ver) throw new Error('CDP 未就绪: ' + err.slice(0, 200));
  browser = await connect(ver.webSocketDebuggerUrl);
  await sleep(1800);

  const { targetInfos } = await browser.call('Target.getTargets');
  let sid = null;
  for (const t of targetInfos.filter(x => x.type === 'service_worker' && x.url.startsWith('chrome-extension://'))) {
    try {
      const { sessionId } = await browser.call('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      const r = await browser.call('Runtime.evaluate', {
        expression: 'chrome.runtime.getManifest().name', returnByValue: true,
      }, sessionId).catch(() => null);
      if (r && r.result && r.result.value === '镜像快车道') { sid = sessionId; break; }
    } catch { /* 跳过 */ }
  }
  if (!sid) throw new Error('扩展未加载');
  await browser.call('Runtime.enable', {}, sid);

  const evalIn = async expr => {
    const r = await browser.call('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    }, sid);
    if (r.exceptionDetails) {
      throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    }
    return r.result.value;
  };

  console.log('\n1. 权限与 API 可用性');
  const cap = await evalIn(`JSON.stringify({
    downloads: typeof chrome.downloads,
    downloadFn: typeof (chrome.downloads && chrome.downloads.download),
    eraseFn: typeof (chrome.downloads && chrome.downloads.erase),
    createObjectURL: typeof URL.createObjectURL,
    hasBlob: typeof Blob
  })`);
  console.log('  ' + cap);
  const c = JSON.parse(cap);
  eq('downloads API 存在', c.downloads, 'object');
  eq('download() 可用', c.downloadFn, 'function');
  ok('SW 里没有 createObjectURL（应走 data: 分支）', c.createObjectURL === 'undefined', c.createObjectURL);

  console.log('\n2. 关闭自动写任务时不应产生文件');
  const off = await evalIn(`(async () => {
    const s = await getSettings();
    await setSettings({ hash: Object.assign({}, s.hash, { enabled: true, auto: false }) });
    return await handlers['intent']({ url: '${TEST_URL}', name: '${TEST_NAME}' });
  })()`);
  eq('返回 disabled', off.skipped, 'disabled');
  await sleep(1500);
  ok('未生成任务文件', !findTaskFile('C:/Users/YI/Downloads'));

  console.log('\n3. 开启后写入任务文件');
  const on = await evalIn(`(async () => {
    const s = await getSettings();
    await setSettings({ hash: Object.assign({}, s.hash, { enabled: true, auto: true }) });
    const r = await handlers['intent']({ url: '${TEST_URL}', name: '${TEST_NAME}' });
    return r;
  })()`);
  console.log('  ' + JSON.stringify(on));
  ok('写入调用成功', on && on.ok === true, JSON.stringify(on));

  await sleep(3000);
  taskPath = findTaskFile('C:/Users/YI/Downloads') || findTaskFile('E:/360Downloads');
  ok('任务文件已落地', !!taskPath, taskPath || '未找到');

  if (taskPath) {
    console.log('  路径: ' + taskPath);
    const raw = readFileSync(taskPath, 'utf8');
    console.log('  内容: ' + raw.slice(0, 200));
    let j = null;
    try { j = JSON.parse(raw); } catch { /* 解析失败 */ }
    ok('内容是合法 JSON', !!j);
    if (j) {
      eq('文件名正确', j.name, TEST_NAME);
      eq('原始地址正确', j.url, TEST_URL);
      eq('带版本号', j.v, 2);
      ok('ts 是毫秒级', typeof j.ts === 'number' && String(j.ts).length === 13, String(j.ts));
      ok('expected 字段存在（此环境未授权 API，应为 null）', j.expected === null || typeof j.expected === 'string');
      ok('source 说明了原因', typeof j.source === 'string' && j.source.length > 0, String(j.source));
      ok('带来源锚点字段（repo/tag/assetId/size 均可缺省为空）',
        typeof j.repo === 'string' && typeof j.tag === 'string' &&
        typeof j.assetId === 'number' && typeof j.size === 'number',
        JSON.stringify({ repo: j.repo, tag: j.tag, assetId: j.assetId, size: j.size }));
    }
  }

  console.log('\n4. 特殊文件名被安全处理');
  const weird = await evalIn(`(async () => {
    return await handlers['hash-task']({
      url: 'https://github.com/o/r/releases/download/v1/x.zip',
      name: 'bad:name*with?chars.zip',
      expected: null, source: 'test'
    });
  })()`);
  console.log('  ' + JSON.stringify(weird));
  const sanitized = weird && weird.name && !/[\\/:*?"<>|]/.test(weird.name);
  ok('非法字符被替换', sanitized, weird && weird.name);

  console.log('\n5. 状态接口');
  const st = await evalIn(`(async () => JSON.stringify(await handlers['hash-state']()))()`);
  console.log('  ' + st);
  const stj = JSON.parse(st);
  ok('返回最近一次写入', !!(stj.lastTask && stj.lastTask.name), st);
  ok('记录了下载意图', typeof stj.intents === 'number' && stj.intents > 0, String(stj.intents));
} catch (e) {
  console.error('\n异常: ' + e.message);
  fail++; failures.push('异常: ' + e.message);
} finally {
  try { browser && browser.close(); } catch { /* ignore */ }
  child.kill();
  await sleep(900);

  // 清理测试产生的任务文件与记录
  if (KEEP) {
    console.log('  --keep：保留任务文件，跳过清理');
    console.log('  任务文件: ' + taskPath);
  } else for (const base of ['C:/Users/YI/Downloads', 'E:/360Downloads']) {
    for (const n of [TEST_NAME + '.task.json', 'bad_name_with_chars.zip.task.json']) {
      const f = join(base, '_mfl-tasks', n);
      try { if (existsSync(f)) { rmSync(f); console.log('  已清理: ' + f); } } catch { /* ignore */ }
    }
    const d = join(base, '_mfl-tasks');
    try {
      if (existsSync(d) && readdirSync(d).length === 0) { rmSync(d, { recursive: true }); console.log('  已清理空目录: ' + d); }
    } catch { /* ignore */ }
  }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n' + '─'.repeat(52));
console.log(`通过 ${pass}  失败 ${fail}`);
if (fail) {
  console.log('\n失败项：');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过');
