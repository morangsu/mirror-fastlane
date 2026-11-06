/* 镜像快车道 - 后台（Service Worker / 事件页 通用） */
'use strict';

if (typeof importScripts === 'function' && typeof MFL === 'undefined') {
  importScripts('lib/core.js', 'lib/idb.js', 'lib/gh-hash.js', 'lib/auto-hash.js');
}

const ext = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

const K = {
  settings: 'settings',
  mirrors: 'mirrors',
  lastProbe: 'lastProbe',
  lastOnDemand: 'lastOnDemand',
  listFetched: 'listFetched',
  intents: 'dlIntents',
  hashSeen: 'hashSeen',
  hashResults: 'hashResults',
  hashStatus: 'hashStatus',
};

const PROBE_TIMEOUT_MS = 12000;
const PROBE_BYTES = 262144;
const PROBE_GAP_MS = 30 * 60 * 1000;   // 按需探测的最小间隔
const ALARM_PROBE = 'mfl-probe';
const ALARM_TICK = 'mfl-tick';

/* ---------------------------------- 存储 ---------------------------------- */

async function getSettings() {
  const o = await ext.storage.local.get(K.settings);
  return Object.assign({}, MFL.DEFAULT_SETTINGS, o[K.settings] || {});
}

async function setSettings(patch) {
  const cur = await getSettings();
  const next = Object.assign({}, cur, patch);
  await ext.storage.local.set({ [K.settings]: next });
  return next;
}

async function getMirrors() {
  const o = await ext.storage.local.get(K.mirrors);
  return Array.isArray(o[K.mirrors]) ? o[K.mirrors] : [];
}

async function setMirrors(list) {
  MFL.scoreMirrors(list);
  await ext.storage.local.set({ [K.mirrors]: list });
  return list;
}

async function seedMirrors() {
  const cur = await getMirrors();
  if (cur.length) return cur;
  let data;
  try {
    const r = await fetch(ext.runtime.getURL('data/builtin-mirrors.json'));
    data = await r.json();
  } catch {
    data = { mirrors: [] };
  }
  const list = (data.mirrors || []).map((m, i) => ({
    id: MFL.idFromBase(m.base),
    name: m.name || MFL.hostOf(m.base),
    base: MFL.normalizeBase(m.base),
    enabled: true,
    source: 'builtin',
    note: m.note || '',
    seedKbps: m.seedKbps || 0,
    healthy: true,
    permitted: false,
    stats: { kbps: 0, ttfb: 0, failures: 0, lastProbe: 0, lastError: '' },
    score: 1 - i / 100,
  }));
  await setMirrors(list);
  return list;
}

/* -------------------------------- 生效条件 -------------------------------- */

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

async function isActiveNow(settings) {
  if (!settings.enabled) return false;
  return MFL.isWithinWindow(settings.activeWindow, nowMinutes());
}

/* --------------------------------- 规则 ---------------------------------- */

async function applyRules() {
  const settings = await getSettings();
  const active = await isActiveNow(settings);
  const mirrors = await getMirrors();
  const want = active ? MFL.buildRules(mirrors, settings) : [];

  const existing = await ext.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map(r => r.id);
  await ext.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: want });

  const best = want.length ? mirrors.filter(m => m.enabled && m.healthy)
    .sort((a, b) => (b.score || 0) - (a.score || 0))[0] : null;

  setBadge(active ? (want.length ? 'ON' : '!') : '', active ? (want.length ? '#1a7f37' : '#b54708') : '#6b7280');
  await ext.storage.local.set({
    ruleInfo: {
      count: want.length,
      active,
      best: best ? { name: best.name, base: best.base, score: best.score } : null,
      updatedAt: Date.now(),
    },
  });
  return { count: want.length, active, best };
}

function setBadge(text, color) {
  try {
    ext.action.setBadgeText({ text: text || '' });
    if (color) ext.action.setBadgeBackgroundColor({ color });
  } catch { /* ignore */ }
}

/* --------------------------------- 探测 ---------------------------------- */

async function hasPermission(base) {
  const pattern = MFL.originPattern(base);
  if (!pattern) return false;
  try {
    return await ext.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

async function probeOne(mirror) {
  const base = String(mirror.base || '').replace(/\/+$/, '');
  const url = base + '/' + MFL.TEST_ASSET;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  const t0 = performance.now();
  let ttfb = 0;
  let bytes = 0;
  let status = 0;
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-' + (PROBE_BYTES - 1) },
      signal: ctrl.signal,
      cache: 'no-store',
      redirect: 'follow',
      credentials: 'omit',
    });
    status = res.status;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!ttfb) ttfb = performance.now() - t0;
        bytes += value.byteLength;
        if (bytes >= PROBE_BYTES) { try { await reader.cancel(); } catch {} break; }
      }
    }
    const total = performance.now() - t0;
    const transfer = Math.max(total - ttfb, 1);
    const kbps = bytes / 1024 / (transfer / 1000);
    return { status, bytes, ttfb: ttfb || total, kbps };
  } catch (e) {
    return { error: true, reason: (e && e.name === 'AbortError') ? 'timeout' : 'fetch-failed', status, bytes };
  } finally {
    clearTimeout(timer);
  }
}

async function runProbe(list, concurrency) {
  const queue = list.slice();
  const out = [];
  const workers = new Array(Math.min(concurrency || 3, queue.length || 1)).fill(0).map(async () => {
    for (;;) {
      const m = queue.shift();
      if (!m) return;
      const permitted = await hasPermission(m.base);
      if (!permitted) {
        out.push({ mirror: m, permitted: false });
        continue;
      }
      const r = await probeOne(m);
      out.push({ mirror: m, permitted: true, result: r });
    }
  });
  await Promise.all(workers);
  return out;
}

async function probeAll(reason) {
  const settings = await getSettings();
  const mirrors = await getMirrors();
  const targets = mirrors.filter(m => m.enabled && (reason !== 'codeload' ? true : true));
  if (!targets.length) return { probed: 0 };

  const results = await runProbe(targets, 3);
  const map = new Map(results.map(r => [r.mirror.id, r]));

  const next = mirrors.map(m => {
    const r = map.get(m.id);
    if (!r) return m;
    if (!r.permitted) {
      return Object.assign({}, m, { permitted: false, stats: Object.assign({}, m.stats, { lastError: '未授权，无法测速' }) });
    }
    const verdict = MFL.evaluateProbe(r.result);
    const fail = verdict.ok ? 0 : ((m.stats && m.stats.failures) || 0) + 1;
    return Object.assign({}, m, {
      permitted: true,
      healthy: fail < 3,
      stats: {
        kbps: verdict.ok ? Math.round(r.result.kbps) : 0,
        ttfb: verdict.ok ? Math.round(r.result.ttfb) : 0,
        failures: fail,
        lastProbe: Date.now(),
        lastError: verdict.ok ? '' : verdict.reason,
      },
    });
  });

  await setMirrors(next);
  const rules = await applyRules();
  if (reason !== 'silent') {
    await ext.storage.local.set({ lastProbe: Date.now() });
  }
  return { probed: results.length, rules };
}

/* --------------------------------- 远程清单 -------------------------------- */

async function fetchRemoteList() {
  const settings = await getSettings();
  const cfg = settings.remoteList || {};
  if (!cfg.enabled || !cfg.url) return { ok: false, reason: 'disabled' };

  const mirrors = await getMirrors();
  const candidates = [];
  const rawUrl = cfg.url;
  mirrors.filter(m => m.enabled && m.permitted).sort((a, b) => (b.score || 0) - (a.score || 0))
    .forEach(m => candidates.push({ via: m.name, url: String(m.base).replace(/\/+$/, '') + '/' + rawUrl }));
  candidates.push({ via: '直连', url: rawUrl });

  for (const c of candidates) {
    try {
      const res = await fetch(c.url, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const data = await res.json();
      const added = await mergeRemoteList(data);
      await ext.storage.local.set({
        [K.listFetched]: { at: Date.now(), via: c.via, added, ok: true },
      });
      await applyRules();
      return { ok: true, via: c.via, added };
    } catch { /* 换下一个 */ }
  }
  await ext.storage.local.set({ [K.listFetched]: { at: Date.now(), via: '', added: 0, ok: false } });
  return { ok: false, reason: 'all-failed' };
}

async function mergeRemoteList(data) {
  const incoming = Array.isArray(data) ? data : (data && data.mirrors) || [];
  const cur = await getMirrors();
  const known = new Set(cur.map(m => MFL.hostOf(m.base)));
  let added = 0;
  incoming.slice(0, 60).forEach(item => {
    const base = MFL.normalizeBase(typeof item === 'string' ? item : item.base);
    if (!base || known.has(MFL.hostOf(base))) return;
    known.add(MFL.hostOf(base));
    cur.push({
      id: MFL.idFromBase(base),
      name: (item && item.name) || MFL.hostOf(base),
      base,
      enabled: true,
      source: 'remote',
      note: (item && item.note) || '',
      healthy: true,
      permitted: false,
      stats: { kbps: 0, ttfb: 0, failures: 0, lastProbe: 0, lastError: '未授权' },
      score: 0,
    });
    added++;
  });
  if (added) await setMirrors(cur);
  return added;
}

/* ------------------------------- 权限同步 ------------------------------- */

async function refreshPermissions() {
  const list = await getMirrors();
  let changed = false;
  for (const m of list) {
    const ok = await hasPermission(m.base);
    if (m.permitted !== ok) { m.permitted = ok; changed = true; }
  }
  if (changed) await setMirrors(list);
  return list;
}

/* ------------------------------ 校验任务文件 ------------------------------ */

const TASK_FOLDER = '_mfl-tasks';
const TASK_MAX_AGE_MS = 24 * 3600 * 1000;

/** 记录用户点击过的下载地址，供核对与展示 */
async function recordIntent(url, name) {
  const o = await ext.storage.local.get(K.intents);
  const now = Date.now();
  const want = AH.normName(name || AH.nameFromUrl(url));
  const list = (o[K.intents] || [])
    .filter(it => it && it.url && now - (it.ts || 0) < TASK_MAX_AGE_MS)
    .filter(it => AH.normName(it.name || AH.nameFromUrl(it.url)) !== want);
  list.push({ url, name: name || AH.nameFromUrl(url), ts: now });
  list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const next = list.slice(0, AH.MAX_INTENTS);
  await ext.storage.local.set({ [K.intents]: next });
  return next;
}

async function getHashStatus() {
  const o = await ext.storage.local.get([K.intents, 'lastTask']);
  return { intents: (o[K.intents] || []).length, lastTask: o.lastTask || null };
}

async function hasApiPermission() {
  try { return await ext.permissions.contains({ origins: ['https://api.github.com/*'] }); }
  catch { return false; }
}

function base64Of(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Service Worker 里没有 URL.createObjectURL，只能用 data:；
 * Firefox 的 event page 有它，但 downloads API 明确拒绝 data:，所以用 blob:。
 * 这是两个内核之间必须的差异。
 */
function makeTaskUrl(payload) {
  const json = JSON.stringify(payload);
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    return { url: URL.createObjectURL(new Blob([json], { type: 'application/json' })), revoke: true };
  }
  return { url: 'data:application/json;base64,' + base64Of(json), revoke: false };
}

function safeFileName(name) {
  return String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120);
}

/**
 * 把校验任务写成 JSON 落到浏览器下载目录的 _mfl-tasks/ 下。
 * 下载目录由浏览器决定，扩展无法指定到别处——这是 downloads API 的硬边界。
 */
async function writeTaskFile(task) {
  if (!ext.downloads || !ext.downloads.download) return { ok: false, reason: 'no-downloads-api' };

  const name = safeFileName(task.name);
  if (!name) return { ok: false, reason: 'bad-name' };

  let made;
  try { made = makeTaskUrl(task); } catch { return { ok: false, reason: 'encode-failed' }; }

  try {
    const id = await ext.downloads.download({
      url: made.url,
      filename: TASK_FOLDER + '/' + name + '.task.json',
      conflictAction: 'overwrite',
      saveAs: false,
    });
    // 从下载列表移除记录（只清历史，不删文件），避免每次下载都留痕
    setTimeout(() => { try { ext.downloads.erase({ id }); } catch { } }, 2000);
    if (made.revoke) setTimeout(() => { try { URL.revokeObjectURL(made.url); } catch { } }, 3000);

    await ext.storage.local.set({ lastTask: { name, at: Date.now(), ok: true } });
    return { ok: true, id, name };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

/** 点击下载时调用：记意图 → 尽力取期望哈希 → 写任务文件交给脚本校验 */
async function createVerifyTask(url, name) {
  const settings = await getSettings();
  if (!settings.hash || !settings.hash.enabled || !settings.hash.auto) {
    return { ok: false, skipped: 'disabled' };
  }

  const finalName = name || AH.nameFromUrl(url);
  if (!finalName) return { ok: false, reason: 'no-name' };

  await recordIntent(url, finalName);

  let expected = null;
  let source = '';
  let meta = { repo: '', tag: '', assetId: 0, size: 0, sourceKind: '' };
  if (await hasApiPermission()) {
    try {
      const r = await GHH.resolveExpected(url, String(settings.token || '').trim(), MFL);
      expected = r.hash;
      source = r.source || '';
      // 这三个锚点让本地脚本能绕过本文件、直接回源 api.github.com 复核哈希来源
      meta = {
        sourceKind: r.sourceKind || '',
        repo: r.repo || '',
        tag: r.tag || '',
        assetId: r.assetId || 0,
        size: r.size || 0,
      };
    } catch (e) {
      source = '未取得：' + String(e && e.message ? e.message : e).slice(0, 60);
    }
  } else {
    source = '未授权 api.github.com';
  }

  return writeTaskFile(Object.assign({
    v: 2, name: finalName, url, expected, source, ts: Date.now(),
  }, meta));
}

/* --------------------------------- 定时器 -------------------------------- */

async function syncAlarms() {
  const settings = await getSettings();
  await ext.alarms.clear(ALARM_PROBE);
  if (settings.probeMode === 'interval' && settings.enabled) {
    const min = Math.max(15, Math.min(1440, settings.probeIntervalMin || 60));
    await ext.alarms.create(ALARM_PROBE, { periodInMinutes: min });
  }
  await ext.alarms.clear(ALARM_TICK);
  await ext.alarms.create(ALARM_TICK, { periodInMinutes: 5 });
}

ext.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === ALARM_PROBE) {
    const s = await getSettings();
    if (!(await isActiveNow(s))) return;
    await probeAll('interval');
  } else if (alarm.name === ALARM_TICK) {
    // 生效时段边界：每 5 分钟校正一次规则状态
    await applyRules();
  }
});

/* --------------------------------- 消息路由 ------------------------------- */

async function getState() {
  const settings = await getSettings();
  const mirrors = await getMirrors();
  const o = await ext.storage.local.get([K.lastProbe, K.listFetched, 'ruleInfo']);
  return {
    settings,
    mirrors,
    lastProbe: o[K.lastProbe] || 0,
    listFetched: o[K.listFetched] || null,
    ruleInfo: o.ruleInfo || { count: 0, active: false, best: null },
    inWindow: await isActiveNow(settings),
  };
}

const handlers = {
  'get-state': () => getState(),

  'save-settings': async msg => {
    const next = await setSettings(msg.patch || {});
    await syncAlarms();
    await applyRules();
    if (next.remoteList && next.remoteList.enabled && next.remoteList.url) {
      fetchRemoteList().catch(() => {});
    }
    return { settings: next };
  },

  'add-mirror': async msg => {
    const base = MFL.normalizeBase(msg.base);
    if (!base) return { ok: false, reason: 'invalid-url' };
    const list = await getMirrors();
    if (list.some(m => MFL.hostOf(m.base) === MFL.hostOf(base))) return { ok: false, reason: 'duplicate' };
    list.push({
      id: MFL.idFromBase(base),
      name: msg.name || MFL.hostOf(base),
      base,
      enabled: true,
      source: 'user',
      note: '',
      healthy: true,
      permitted: !!msg.permitted,
      stats: { kbps: 0, ttfb: 0, failures: 0, lastProbe: 0, lastError: '' },
      score: 0,
    });
    await setMirrors(list);
    await applyRules();
    return { ok: true, state: await getState() };
  },

  'remove-mirror': async msg => {
    const list = (await getMirrors()).filter(m => m.id !== msg.id);
    await setMirrors(list);
    await applyRules();
    return { ok: true, state: await getState() };
  },

  'toggle-mirror': async msg => {
    const list = await getMirrors();
    const m = list.find(x => x.id === msg.id);
    if (m) m.enabled = !!msg.enabled;
    await setMirrors(list);
    await applyRules();
    return { ok: true, state: await getState() };
  },

  'update-mirror': async msg => {
    const list = await getMirrors();
    const m = list.find(x => x.id === msg.id);
    if (m) {
      if (msg.name) m.name = msg.name;
      if (typeof msg.permitted === 'boolean') m.permitted = msg.permitted;
    }
    await setMirrors(list);
    await applyRules();
    return { ok: true, state: await getState() };
  },

  'probe-all': async () => probeAll('manual'),
  'probe-one': async msg => {
    const list = await getMirrors();
    const m = list.find(x => x.id === msg.id);
    if (!m) return { ok: false };
    const permitted = await hasPermission(m.base);
    if (!permitted) return { ok: false, reason: 'no-permission' };
    const r = await probeOne(m);
    const verdict = MFL.evaluateProbe(r);
    m.permitted = true;
    m.healthy = verdict.ok ? true : (m.stats.failures || 0) + 1 < 3;
    m.stats = {
      kbps: verdict.ok ? Math.round(r.kbps) : 0,
      ttfb: verdict.ok ? Math.round(r.ttfb) : 0,
      failures: verdict.ok ? 0 : (m.stats.failures || 0) + 1,
      lastProbe: Date.now(),
      lastError: verdict.ok ? '' : verdict.reason,
    };
    await setMirrors(list);
    await applyRules();
    return { ok: verdict.ok, verdict, state: await getState() };
  },

  'apply': async () => ({ ok: true, rules: await applyRules() }),
  'refresh-permissions': async () => { await refreshPermissions(); await applyRules(); return { ok: true, state: await getState() }; },
  'fetch-list': async () => fetchRemoteList(),
  'sync-alarms': async () => { await syncAlarms(); return { ok: true }; },

  'badge-info': async () => {
    const settings = await getSettings();
    const active = await isActiveNow(settings);
    const mirrors = await getMirrors();
    const best = mirrors.filter(m => m.enabled && m.healthy)
      .sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;
    return {
      active,
      markLinks: settings.markLinks,
      clickToast: settings.clickToast,
      codeload: !!(settings.codeload && settings.codeload.enabled),
      hashAuto: !!(settings.hash && settings.hash.enabled && settings.hash.auto),
      best: best ? { name: best.name, host: MFL.hostOf(best.base) } : null,
    };
  },

  /* --------------------------- 校验任务文件 --------------------------- */

  // 页面点击下载时由内容脚本上报：记下意图并写出校验任务，交给本地脚本比对
  'intent': async msg => {
    if (!msg || !msg.url) return { ok: false };
    return createVerifyTask(msg.url, msg.name);
  },

  'hash-state': async () => Object.assign({ ok: true }, await getHashStatus()),

  'hash-forget': async () => {
    await ext.storage.local.remove([K.intents, 'lastTask', K.hashSeen, K.hashResults, 'hashStatus']);
    return Object.assign({ ok: true }, await getHashStatus());
  },

  // 手动补写一个任务文件（调试或补发用）
  'hash-task': async msg => {
    if (!msg || !msg.url) return { ok: false };
    return writeTaskFile({
      v: 2, name: msg.name || AH.nameFromUrl(msg.url), url: msg.url,
      expected: msg.expected || null, source: msg.source || '手动', ts: Date.now(),
      sourceKind: msg.sourceKind || 'manual',
      repo: msg.repo || '', tag: msg.tag || '', assetId: msg.assetId || 0, size: msg.size || 0,
    });
  },

  'maybe-probe': async () => {
    const settings = await getSettings();
    if (settings.probeMode !== 'ondemand') return { ok: false, skipped: 'mode' };
    if (!(await isActiveNow(settings))) return { ok: false, skipped: 'window' };
    const o = await ext.storage.local.get([K.lastOnDemand]);
    const last = o[K.lastOnDemand] || 0;
    if (Date.now() - last < PROBE_GAP_MS) return { ok: false, skipped: 'throttle' };
    await ext.storage.local.set({ [K.lastOnDemand]: Date.now() });
    probeAll('ondemand').catch(() => {});
    return { ok: true };
  },
};

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = handlers[msg && msg.type];
  if (!fn) return false;
  Promise.resolve(fn(msg, sender))
    .then(r => sendResponse(r))
    .catch(e => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
  return true;   // 异步响应
});

/* --------------------------------- 生命周期 ------------------------------- */

async function bootstrap() {
  // 首次安装时把默认设置落盘，避免 storage 里没有 settings 键
  const raw = await ext.storage.local.get(K.settings);
  if (!raw[K.settings]) {
    await ext.storage.local.set({ [K.settings]: JSON.parse(JSON.stringify(MFL.DEFAULT_SETTINGS)) });
  }
  await seedMirrors();
  await refreshPermissions();
  await syncAlarms();
  await applyRules();
}

ext.runtime.onInstalled.addListener(() => { bootstrap().catch(() => {}); });
ext.runtime.onStartup.addListener(() => { bootstrap().catch(() => {}); });
bootstrap().catch(() => {});
