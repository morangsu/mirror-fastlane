/* 镜像快车道 - 自动校验的纯逻辑（无副作用，便于单元测试） */
'use strict';

(function (root) {
  const api = {};

  const MAX_RESULTS = 20;
  const INTENT_TTL_MS = 24 * 3600 * 1000;
  const MAX_INTENTS = 60;

  /** 文件名规范化：比较时忽略大小写与首尾空白 */
  function normName(name) {
    return String(name == null ? '' : name).trim().toLowerCase();
  }

  /** 从下载地址里推文件名（不依赖 MFL，便于独立测试） */
  function nameFromUrl(url) {
    try {
      const u = new URL(url);
      const seg = u.pathname.split('/').pop() || '';
      return decodeURIComponent(seg);
    } catch {
      return '';
    }
  }

  /** outbox 条目的唯一键：路径 + 时间戳 */
  function entryKey(e) {
    return String((e && e.path) || '') + '|' + String((e && e.ts) || '');
  }

  /** 找出本次新出现的条目（按 entryKey 去重） */
  function freshEntries(prevKeys, entries) {
    const seen = new Set(prevKeys || []);
    return (entries || []).filter(e => !seen.has(entryKey(e)));
  }

  /** 只保留值得校验的：状态成功且有 64 位哈希 */
  function verifiable(entries) {
    return (entries || []).filter(e =>
      e && e.status === 'ok' && typeof e.hash === 'string' && /^[a-f0-9]{64}$/.test(e.hash));
  }

  /**
   * 按文件名把 outbox 条目匹配到"用户点过哪个下载"。
   * 多个候选时取时间上最近的一条。
   */
  function matchIntent(intents, name, now) {
    const want = normName(name);
    if (!want) return null;
    const t = now || Date.now();
    let best = null;
    for (const it of intents || []) {
      if (!it || !it.url) continue;
      if (t - (it.ts || 0) > INTENT_TTL_MS) continue;      // 过期意图不参与
      const itName = normName(it.name || nameFromUrl(it.url));
      if (itName !== want) continue;
      if (!best || (it.ts || 0) > (best.ts || 0)) best = it;
    }
    return best;
  }

  /** 记录下载意图：同名覆盖、限长、剔除过期 */
  function pushIntent(intents, intent, now) {
    const t = now || Date.now();
    const name = intent.name || nameFromUrl(intent.url);
    if (!intent.url || !name) return intents || [];
    const kept = (intents || []).filter(it =>
      it && normName(it.name || nameFromUrl(it.url)) !== normName(name) && t - (it.ts || 0) <= INTENT_TTL_MS);
    kept.push({ url: intent.url, name, ts: t });
    kept.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return kept.slice(0, MAX_INTENTS);
  }

  /** 追加校验结果，保留最近 MAX_RESULTS 条 */
  function pushResult(results, r) {
    const list = Array.isArray(results) ? results.slice() : [];
    list.unshift(r);
    return list.slice(0, MAX_RESULTS);
  }

  /**
   * 判定一条新鲜 outbox 条目该不该校验、以及为什么跳过。
   * @returns {{action:'verify'|'skip', reason?:string, intent?:object}}
   */
  function decide(entry, intents, now) {
    if (!entry) return { action: 'skip', reason: 'empty' };
    if (entry.status !== 'ok') return { action: 'skip', reason: 'download-failed' };
    if (!entry.hash || !/^[a-f0-9]{64}$/.test(entry.hash)) return { action: 'skip', reason: 'no-hash' };
    const intent = matchIntent(intents, entry.name, now);
    if (!intent) return { action: 'skip', reason: 'no-intent' };
    return { action: 'verify', intent };
  }

  api.normName = normName;
  api.nameFromUrl = nameFromUrl;
  api.entryKey = entryKey;
  api.freshEntries = freshEntries;
  api.verifiable = verifiable;
  api.matchIntent = matchIntent;
  api.pushIntent = pushIntent;
  api.pushResult = pushResult;
  api.decide = decide;
  api.MAX_RESULTS = MAX_RESULTS;
  api.INTENT_TTL_MS = INTENT_TTL_MS;
  api.MAX_INTENTS = MAX_INTENTS;

  root.AH = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
