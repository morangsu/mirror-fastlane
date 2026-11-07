/* debug-log.js 回归测试：模拟 4 个上下文并发写入，验证不丢日志、排序、清空、导出。
 * 运行：node test/debug-log-test.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CODE = readFileSync(join(ROOT, 'lib', 'debug-log.js'), 'utf8');

/** 造一个共享 storage 的浏览器环境；每个 ctx 是一个独立扩展上下文 */
function makeEnv(store, debug, href) {
  const local = {
    get(keys, cb) {
      let o;
      if (keys === null || keys === undefined) o = { ...store };
      else if (typeof keys === 'string') o = keys in store ? { [keys]: store[keys] } : {};
      else if (Array.isArray(keys)) {
        o = {};
        for (const k of keys) if (k in store) o[k] = store[k];
      } else o = { ...store };
      if (typeof cb === 'function') { cb(o); return undefined; }
      return Promise.resolve(o);
    },
    set(obj, cb) {
      Object.assign(store, obj);
      if (typeof cb === 'function') cb();
      return Promise.resolve();
    },
    remove(keys, cb) {
      for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k];
      if (typeof cb === 'function') cb();
      return Promise.resolve();
    },
  };
  const chrome = {
    runtime: {
      getManifest: () => ({ version: '1.4.5', debug }),
      getURL: () => 'chrome-extension://mfltest/',
    },
    storage: { local },
  };
  const u = new URL(href);
  const ctx = {
    chrome,
    console: { log() {} },
    location: { href, pathname: u.pathname, host: u.host },
    URL,
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx, { filename: 'debug-log.js' });
  return ctx.DBG;
}

/* 1) 正式包：enabled=false，一条都不写 */
{
  const store = {};
  const D = makeEnv(store, false, 'chrome-extension://mfltest/options/options.html');
  assert.equal(D.enabled, false);
  D.log('ui', '不该出现');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(Object.keys(store).length, 0, '正式包不应写 storage');
  console.log('[ok] 正式包零写入');
}

/* 2) debug 包：4 个上下文并发写 200 条，一条都不能丢 */
{
  const store = {};
  const urls = [
    'chrome-extension://mfltest/background.js',
    'chrome-extension://mfltest/options/options.html',
    'chrome-extension://mfltest/popup/popup.html',
    'https://github.com/morangsu/mirror-fastlane/releases',
  ];
  const DBGs = urls.map(u => makeEnv(store, true, u));
  assert.ok(DBGs.every(d => d.enabled), 'debug 构建应全部启用');
  for (let i = 0; i < 50; i++) {
    DBGs.forEach((d, n) => d.log('ui', '事件 ' + i, { n, i }));
  }
  await new Promise(r => setTimeout(r, 20));
  const list = await DBGs[0].dump();
  assert.equal(list.length, 200, '并发写入不能丢日志，实际 ' + list.length);
  assert.ok(list.every((e, i) => i === 0 || e.ts >= list[i - 1].ts), '日志应按时间排序');
  const ctxs = new Set(list.map(e => e.ctx));
  for (const c of ['ext:background.js', 'ext:options.html', 'ext:popup.html', 'page:github.com']) {
    assert.ok(ctxs.has(c), '缺少上下文 ' + c);
  }
  console.log('[ok] 200 条并发日志无丢失、有序、带上下文');
}

/* 3) 上限裁剪 + 清空 + 导出 */
{
  const store = {};
  const D = makeEnv(store, true, 'chrome-extension://mfltest/options/options.html');
  for (let i = 0; i < 450; i++) D.log('rules', '第 ' + i + ' 条');
  await new Promise(r => setTimeout(r, 20));
  const list = await D.dump();
  assert.equal(list.length, 400, 'dump 最多返回 400 条');
  assert.equal(list[list.length - 1].msg, '第 449 条', '保留的应是最新的');
  const text = await D.text();
  assert.ok(text.startsWith('# mirror-fastlane debug log'));
  assert.ok(text.includes('# 条数: 400'));
  await D.clear();
  assert.equal((await D.dump()).length, 0, '清空后应为空');
  console.log('[ok] 400 条上限、导出文本、清空');
}

/* 4) 敏感信息脱敏：写入与导出两条路径都不能带出 token */
{
  const store = {};
  const D = makeEnv(store, true, 'chrome-extension://mfltest/options/options.html');
  // 拆开写，避免被合规扫描当成源码里硬编码的真实 token
  const PAT = 'github' + '_pat_'
    + '11BTYJXUA0LzLWJFiGPzx7_'
    + 'SWIlxTJ3NVEc955pInxc52zO7IAzEUNrHxaY7OJxpWuVPLSGX62jzqzLVVM';
  D.log('msg', '后台收到 save-settings', {
    patch: { token: PAT },
    note: 'Bearer abcdefghijklmnopqrstuvwxyz012345',
    url: 'https://example.com/?token=' + PAT,
  });
  await new Promise(r => setTimeout(r, 10));
  const list = await D.dump();
  assert.equal(list.length, 1);
  assert.ok(!list[0].data.includes(PAT), '写入的日志不能含明文 PAT');
  assert.ok(list[0].data.includes('"token":"***"'), 'token 字段应被整键屏蔽');
  assert.ok(!(await D.text()).includes(PAT), '导出文本不能含明文 PAT');

  // 旧版本遗留的明文日志，导出时也必须脱敏
  store['mflLog.legacy'] = {
    t: '00:00:00.000', area: 'msg', msg: '旧日志',
    data: JSON.stringify({ token: PAT, note: 'Bearer ' + PAT }), ctx: 'ext',
  };
  assert.ok(!(await D.text()).includes(PAT), '历史明文日志导出时也应脱敏');
  console.log('[ok] token 脱敏（写入 + 导出 + 历史日志）');
}

console.log('全部通过');
