/* 内容脚本状态刷新回归测试（纯离线，用最小 DOM/Chrome API 模拟）
 * 覆盖：设置变更广播、点击时实时取状态、后台无响应时的超时兜底。
 * 运行： node test/content-state-test.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODE = readFileSync(join(ROOT, 'content', 'content.js'), 'utf8');
const RELEASE = 'https://github.com/o/r/releases/download/v1.0.0/app-1.0.0.zip';

const tick = (n = 4) => new Promise(res => setImmediate(() => --n > 0 ? setImmediate(res) : res()));

function harness() {
  const listeners = {};
  const storageListeners = [];
  const sent = [];
  let state = {
    active: true, markLinks: true, clickToast: false, codeload: false,
    hashAuto: false, best: { name: 'X', host: 'x.test' },
    hash: { enabled: false, auto: false, hasToken: false },
  };
  let hangBadge = false;

  const el = () => ({
    style: {}, className: '', textContent: '', title: '', _t: null,
    setAttribute() {}, removeAttribute() {}, appendChild() {},
    insertBefore() {}, remove() {}, setAttributeNode() {},
  });
  const document = {
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    createElement: el,
    documentElement: el(),
  };
  class MutationObserver {
    constructor(cb) { this.cb = cb; }
    observe() {}
    disconnect() {}
  }
  const chrome = {
    runtime: {
      sendMessage: msg => {
        sent.push(msg);
        if (msg.type === 'badge-info') {
          if (hangBadge) return new Promise(() => {});   // 永不响应
          return Promise.resolve(state);
        }
        if (msg.type === 'intent') return Promise.resolve({ ok: true });
        return Promise.resolve({});
      },
    },
    storage: { onChanged: { addListener: fn => storageListeners.push(fn) } },
  };

  const ctx = vm.createContext({
    chrome, browser: undefined, document, MutationObserver,
    location: { href: 'https://github.com/o/r/releases/tag/v1.0.0' },
    console: { log() {} }, URL, setTimeout, clearTimeout, Promise,
    // 不提供 DBG / MFL，走内容脚本里的空实现兜底
  });
  vm.runInContext(CODE, ctx, { filename: 'content/content.js' });

  return {
    sent,
    get state() { return state; },
    set state(v) { state = v; },
    setHang(v) { hangBadge = v; },
    click(href = RELEASE) {
      const handler = (listeners.click || []).slice(-1)[0];
      assert.ok(handler, '内容脚本应注册 click 监听');
      return Promise.resolve(handler({
        target: { closest: () => ({ href }) },
      }));
    },
    changeSettings() {
      assert.ok(storageListeners.length, '内容脚本应注册 storage.onChanged');
      storageListeners.forEach(fn => fn({ settings: { newValue: state } }, 'local'));
    },
  };
}

let pass = 0;
function ok(name, cond, extra) {
  assert.ok(cond, name + (extra ? ' → ' + extra : ''));
  pass++;
  console.log('  ✓', name);
}

(async () => {
  console.log('内容脚本状态刷新测试');

  // 1. 页面打开时 hashAuto=false：点击不该上报 intent
  await tick();
  {
    const h = harness();
    await tick();
    await h.click();
    ok('未开启时点击不发 intent', !h.sent.some(m => m.type === 'intent'));
    ok('未开启时也会查询状态', h.sent.some(m => m.type === 'badge-info'));
  }

  // 2. 页面不刷新，只在设置页开启自动校验 → 广播后点击应立刻生效
  {
    const h = harness();
    await tick();
    h.state = Object.assign({}, h.state, {
      hashAuto: true, hash: { enabled: true, auto: true, hasToken: true },
    });
    h.changeSettings();
    await tick(8);
    await h.click();
    const intent = h.sent.find(m => m.type === 'intent');
    ok('设置变更后无需刷新页面即可登记', !!intent);
    ok('intent 用的是官方直链', intent && intent.url === RELEASE, intent && intent.url);
    ok('intent 带正确文件名', intent && intent.name === 'app-1.0.0.zip', intent && intent.name);
  }

  // 3. 即便广播丢失，点击时也会自己重取一次状态
  {
    const h = harness();
    await tick();
    h.state = Object.assign({}, h.state, {
      hashAuto: true, hash: { enabled: true, auto: true, hasToken: false },
    });
    await h.click();          // 故意不触发 storage.onChanged
    ok('点击时实时取状态（广播丢失也能兜底）',
      h.sent.some(m => m.type === 'intent'));
  }

  // 4. 非 GitHub 链接不应触发任何查询或上报
  {
    const h = harness();
    await tick();
    const before = h.sent.length;
    await h.click('https://example.com/a.zip');
    ok('非下载链接不触发查询', h.sent.length === before);
  }

  console.log('通过 ' + pass + ' 项');
  console.log('全部通过');
})().catch(e => { console.error('测试失败:', e.message); process.exit(1); });
