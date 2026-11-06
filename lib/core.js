/* 镜像快车道 - 共享纯逻辑层
 * 同时用于：浏览器扩展（挂到 globalThis.MFL）、Node 测试（module.exports）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MFL = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_SETTINGS = {
    enabled: true,
    markLinks: true,
    clickToast: true,
    probeMode: 'ondemand',        // ondemand | interval
    probeIntervalMin: 60,
    probeCacheHours: 2,
    activeWindow: { enabled: false, start: '20:00', end: '02:00' },
    codeload: { enabled: false, probeOn: false },
    remoteList: { enabled: false, url: '', lastFetched: 0, lastSource: '' },
    hash: { enabled: false, auto: false },
    token: '',
  };

  // release 直链（下载时走 main_frame，IDM 捕获也用这个）
  const RELEASE_REGEX = '^https://github\\.com/[^/]+/[^/]+/releases/download/.+$';
  // 源码包
  const CODELOAD_REGEX = '^https://codeload\\.github\\.com/.+$';

  const TEST_ASSET =
    'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-pc-windows-msvc.zip';

  /** 把用户输入规范成 https 根地址：ghfast.top / https://ghfast.top/ -> https://ghfast.top */
  function normalizeBase(input) {
    if (!input) return null;
    let s = String(input).trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    let u;
    try { u = new URL(s); } catch { return null; }
    if (u.protocol !== 'https:') return null;
    if (!/^[a-z0-9.-]+$/i.test(u.hostname)) return null;
    if (u.hostname.indexOf('.') < 0) return null;
    return 'https://' + u.hostname + (u.port ? ':' + u.port : '');
  }

  function hostOf(base) {
    try { return new URL(base).host; } catch { return ''; }
  }

  function originPattern(base) {
    const h = hostOf(base);
    return h ? 'https://' + h + '/*' : null;
  }

  function idFromBase(base) {
    return hostOf(base).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  }

  /** HH:MM -> 分钟数，非法返回 null */
  function parseHHMM(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }

  /** 生效时段判断，支持跨天（20:00-02:00） */
  function isWithinWindow(win, nowMinutes) {
    if (!win || !win.enabled) return true;
    const a = parseHHMM(win.start);
    const b = parseHHMM(win.end);
    if (a === null || b === null) return true;
    if (a === b) return true;
    return a < b ? (nowMinutes >= a && nowMinutes < b) : (nowMinutes >= a || nowMinutes < b);
  }

  /** 生成 DNR 动态规则：按得分从高到低排队，先匹配先赢
   *  注意：跳转本身不需要镜像域名的 host 权限（浏览器只校验请求方与发起方），
   *  所以这里只按「启用 + 健康」过滤；host 权限只用于测速。
   */
  function buildRules(mirrors, settings) {
    const active = mirrors
      .filter(m => m.enabled && m.healthy)
      .sort((x, y) => (y.score || 0) - (x.score || 0));
    if (!active.length) return [];
    const out = [];
    let id = 1;
    active.forEach((m, i) => {
      const base = normalizeBase(m.base);
      if (!base) return;
      const host = hostOf(base);
      const prio = 1000 - i;
      out.push({
        id: id++,
        priority: prio,
        action: {
          type: 'redirect',
          redirect: { regexSubstitution: base + '/\\0' },
        },
        condition: {
          regexFilter: RELEASE_REGEX,
          resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'object', 'other'],
        },
      });
      if (settings && settings.codeload && settings.codeload.enabled) {
        out.push({
          id: id++,
          priority: prio,
          action: {
            type: 'redirect',
            redirect: { regexSubstitution: base + '/\\0' },
          },
          condition: {
            regexFilter: CODELOAD_REGEX,
            resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'object', 'other'],
          },
        });
      }
    });
    return out;
  }

  /** 把 DNR 的 regexSubstitution 语义在本地算出来（\0 = 整段匹配），供测试断言 */
  function applyRegexSubstitution(regex, subst, url) {
    const re = new RegExp(regex);
    if (!re.test(url)) return null;
    const pattern = String(subst).split('\\0').join('$&');
    return url.replace(re, pattern);
  }

  /** 打分：吞吐 70% + 延迟 30%；全都没测过则按数组顺序保留优先级 */
  function scoreMirrors(items) {
    const measured = items.filter(m => m.stats && m.stats.kbps > 0 && m.stats.ttfb > 0);
    if (!measured.length) {
      const n = Math.max(items.length, 1);
      items.forEach((m, i) => { m.score = Math.round(((n - i) / n) * 1000) / 1000; });
      return items;
    }
    const maxK = Math.max.apply(null, measured.map(m => m.stats.kbps).concat([1]));
    const minT = Math.min.apply(null, measured.map(m => m.stats.ttfb).concat([999999]));
    items.forEach(m => {
      if (m.stats && m.stats.kbps > 0 && m.stats.ttfb > 0) {
        const k = m.stats.kbps / maxK;
        const t = minT / m.stats.ttfb;
        m.score = Math.round((k * 0.7 + t * 0.3) * 1000) / 1000;
      } else {
        m.score = 0;
      }
    });
    return items;
  }

  /** 判定一次探测结果是否健康 */
  function evaluateProbe(result) {
    const MIN_KBPS = 20;
    if (!result || result.error) {
      return { ok: false, reason: result && result.reason ? result.reason : 'error' };
    }
    if (result.status !== 200 && result.status !== 206) {
      return { ok: false, reason: 'http-' + result.status };
    }
    if (!result.bytes) return { ok: false, reason: 'empty' };
    if (result.kbps < MIN_KBPS) return { ok: false, reason: 'too-slow' };
    return { ok: true, reason: 'ok' };
  }

  /** outbox 单行解析： 路径|sha256|状态|时间戳|可信度（第 5 段可选，旧脚本没有） */
  function parseOutboxLine(line) {
    const s = String(line || '').trim();
    if (!s || s.charAt(0) === '#') return null;
    const parts = s.split('|');
    if (parts.length < 3) return null;
    const path = parts[0].trim();
    const hash = (parts[1] || '').trim().toLowerCase();
    const status = (parts[2] || '').trim().toLowerCase();
    let ts = parseInt(parts[3], 10);
    if (isNaN(ts) || ts < 0) ts = 0;
    // 兼容秒级时间戳（早期脚本用 ToUnixTimeSeconds 写入），统一成毫秒
    if (ts > 0 && ts < 1e12) ts *= 1000;
    if (!path) return null;
    if (hash && !/^[a-f0-9]{64}$/.test(hash)) return null;
    // 可信度：pass=已回源复核一致 / pass-unverified=只信了本地任务文件 /
    //         conflict=任务文件与 GitHub API 不一致 / none=没拿到官方哈希
    const rawTrust = (parts[4] || '').trim().toLowerCase();
    const trust = ['pass', 'pass-unverified', 'conflict', 'none'].indexOf(rawTrust) >= 0 ? rawTrust : '';
    return {
      path,
      name: path.split(/[\\/]/).pop(),
      hash,
      status: status === 'ok' ? 'ok' : 'fail',
      ts,
      trust,
    };
  }

  /** 多文件并发下载：同路径保留最新，按时间倒序 */
  function mergeOutbox(lines, limit) {
    const map = new Map();
    lines.forEach(l => {
      const e = parseOutboxLine(l);
      if (!e) return;
      const prev = map.get(e.path);
      if (!prev || e.ts >= prev.ts) map.set(e.path, e);
    });
    return Array.from(map.values()).sort((a, b) => b.ts - a.ts).slice(0, limit || 200);
  }

  /** 裁剪 outbox：保留最近 N 行 + 7 天内 */
  function trimOutbox(lines, opts) {
    const max = (opts && opts.max) || 200;
    const keepMs = (opts && opts.keepMs) || 7 * 24 * 3600 * 1000;
    const now = (opts && opts.now) || Date.now();
    const kept = lines.filter(l => {
      const e = parseOutboxLine(l);
      if (!e) return false;
      return !e.ts || now - e.ts < keepMs;
    });
    return kept.slice(-max);
  }

  function isValidSha256(s) {
    return /^[a-f0-9]{64}$/i.test(String(s || '').trim());
  }

  function stripSha256Prefix(s) {
    return String(s || '').trim().replace(/^sha256:/i, '').toLowerCase();
  }

  function formatKbps(kbps) {
    if (!kbps) return '—';
    if (kbps >= 1024) return (kbps / 1024).toFixed(1) + ' MB/s';
    return Math.round(kbps) + ' KB/s';
  }

  function formatMs(ms) {
    if (!ms) return '—';
    return Math.round(ms) + ' ms';
  }

  function relativeTime(ts, now) {
    if (!ts) return '从未';
    const d = Math.max(0, (now || Date.now()) - ts);
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    return Math.floor(d / 86400000) + ' 天前';
  }

  /** 从 release 页面 URL 推断 API 地址：/owner/repo/releases/tag/v1 */
  function parseReleaseUrl(u) {
    try {
      const url = new URL(u);
      if (!/(^|\.)github\.com$/.test(url.hostname)) return null;
      const seg = url.pathname.split('/').filter(Boolean);
      if (seg.length < 5) return null;
      if (seg[2] !== 'releases') return null;
      const owner = seg[0], repo = seg[1];
      if (seg[3] === 'tag' && seg[4]) {
        return { owner, repo, tag: seg.slice(4).join('/') };
      }
      if (seg[3] === 'download') {
        return { owner, repo, tag: null };
      }
      return null;
    } catch { return null; }
  }

  /** 从下载直链里取出文件名 */
  function fileNameFromUrl(u) {
    try {
      const url = new URL(u);
      const seg = url.pathname.split('/').filter(Boolean);
      return decodeURIComponent(seg[seg.length - 1] || '');
    } catch { return ''; }
  }

  return {
    DEFAULT_SETTINGS,
    RELEASE_REGEX,
    CODELOAD_REGEX,
    TEST_ASSET,
    normalizeBase,
    hostOf,
    originPattern,
    idFromBase,
    parseHHMM,
    isWithinWindow,
    buildRules,
    applyRegexSubstitution,
    scoreMirrors,
    evaluateProbe,
    parseOutboxLine,
    mergeOutbox,
    trimOutbox,
    isValidSha256,
    stripSha256Prefix,
    formatKbps,
    formatMs,
    relativeTime,
    parseReleaseUrl,
    fileNameFromUrl,
  };
});
