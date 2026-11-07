/* 调试日志：只在 manifest 里带 "debug": true 的构建中生效，正式包不会有任何写入。
 *
 * 写入模型：每条日志用唯一键直接 storage.local.set，不做「读整个数组 → 改 → 写回」。
 * 后台、内容脚本、设置页、弹窗可能在同一毫秒各写一条，读改写必然互相覆盖；
 * 唯一键追加天然无竞态，dump() 时按时间排序即可。
 */
(function (root) {
  'use strict';

  const PREFIX = 'mflLog.';
  const MAX = 400;

  let enabled = null;
  let seq = 0;
  let writes = 0;

  function isEnabled() {
    if (enabled !== null) return enabled;
    try {
      const mf = chrome.runtime.getManifest();
      enabled = !!(mf && mf.debug === true);
    } catch {
      enabled = false;
    }
    return enabled;
  }

  // 标记日志来自哪个上下文，排查「消息有没有到后台」时很关键
  const CTX = (function () {
    try {
      const loc = root.location;
      if (!loc) return 'bg';
      const own = chrome.runtime.getURL('');
      if (loc.href.indexOf(own) === 0) return 'ext:' + (loc.pathname.split('/').pop() || 'page');
      return 'page:' + (loc.host || '?');
    } catch { return '?'; }
  })();

  function now() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  /* 日志里绝不能出现 token：设置页改 token 时整个 patch 都会被记下来。
   * 除了按字段名屏蔽，也对字符串值做正则替换，防止 URL / 报错文本里夹带。
   */
  const SECRET_KEY = /(?:token|secret|password|passwd|authorization|api[-_]?key|credential)/i;
  const SECRET_VAL = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._-]{20,})/gi;

  function hideMatch(m) { return m.slice(0, 8) + '***'; }

  function scrub(v, depth) {
    const d = depth || 0;
    if (d > 6) return '[…]';
    if (typeof v === 'string') return v.replace(SECRET_VAL, hideMatch);
    if (Array.isArray(v)) return v.map(x => scrub(x, d + 1));
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) {
        o[k] = SECRET_KEY.test(k) ? '***' : scrub(v[k], d + 1);
      }
      return o;
    }
    return v;
  }

  function fmt(data) {
    if (data === undefined || data === null) return '';
    try { return JSON.stringify(scrub(data)); } catch { return String(data).replace(SECRET_VAL, hideMatch); }
  }

  function allKeys(o) {
    return Object.keys(o).filter(k => k.indexOf(PREFIX) === 0).sort();
  }

  /** 写一条日志。area 分组：ui / msg / content / intent / task / rules / download / boot */
  function log(area, msg, data) {
    if (!isEnabled()) return;
    const safe = scrub(data);
    const line = { t: now(), ts: Date.now(), area, msg, data: fmt(safe), ctx: CTX };
    try { console.log('[mfl:' + area + ']', msg, safe === undefined ? '' : safe); } catch { /* ignore */ }

    const key = PREFIX + String(line.ts).padStart(13, '0') + '.'
      + String(seq++).padStart(4, '0') + '.' + Math.random().toString(36).slice(2, 6);
    try {
      chrome.storage.local.set({ [key]: line }, () => {
        // 每 40 条清一次旧键，避免无限增长；失败不影响主流程
        if (++writes % 40 === 0) prune().catch(() => {});
      });
    } catch { /* 内容脚本在个别页面可能拿不到 storage */ }
  }

  async function dump() {
    try {
      const o = await chrome.storage.local.get(null);
      const ks = allKeys(o);
      return ks.slice(-MAX).map(k => o[k]).filter(Boolean);
    } catch { return []; }
  }

  async function prune() {
    const o = await chrome.storage.local.get(null);
    const ks = allKeys(o);
    if (ks.length <= MAX) return;
    await chrome.storage.local.remove(ks.slice(0, ks.length - MAX));
  }

  async function clear() {
    // 兼容早期构建写进单个 debugLog 键的旧日志
    const o = await chrome.storage.local.get(null);
    const ks = allKeys(o);
    if (o.debugLog) ks.push('debugLog');
    if (ks.length) await chrome.storage.local.remove(ks);
  }

  function formatLine(e) {
    // 导出时再脱敏一次：旧版本写进 storage 的日志可能仍含明文 token
    let data = e.data ? String(e.data) : '';
    if (data) {
      try { data = JSON.stringify(scrub(JSON.parse(data))); }
      catch { data = data.replace(SECRET_VAL, hideMatch); }
    }
    return e.t + ' [' + (e.area || '?') + '] ' + (e.msg || '')
      + (data ? '  ' + data : '')
      + (e.ctx ? '  <' + e.ctx + '>' : '');
  }

  async function text() {
    const list = await dump();
    const head = [
      '# mirror-fastlane debug log',
      '# 导出时间: ' + new Date().toLocaleString(),
      '# 版本: ' + (function () { try { return chrome.runtime.getManifest().version; } catch { return '?'; } })(),
      '# 条数: ' + list.length,
      '',
    ];
    return head.join('\r\n') + list.map(formatLine).join('\r\n') + '\r\n';
  }

  root.DBG = { log, dump, clear, prune, text, formatLine, get enabled() { return isEnabled(); } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
