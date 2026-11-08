/* 镜像快车道 - 后台（Service Worker / 事件页 通用） */
'use strict';

if (typeof importScripts === 'function' && typeof MFL === 'undefined') {
  importScripts('lib/core.js', 'lib/idb.js', 'lib/gh-hash.js', 'lib/auto-hash.js', 'lib/debug-log.js');
}

const ext = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;
// 调试日志：正式包里 DBG 存在但 enabled=false，所有调用都是空操作
const dbg = (area, msg, data) => { if (typeof DBG !== 'undefined') DBG.log(area, msg, data); };

const K = {
  settings: 'settings',
  mirrors: 'mirrors',
  lastProbe: 'lastProbe',
  lastOnDemand: 'lastOnDemand',
  listFetched: 'listFetched',
  listAttempt: 'listAttempt',
  listMissing: 'listMissing',
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
const ALARM_LIST = 'mfl-list';
const LIST_REFRESH_MS = 24 * 3600 * 1000;   // 远程清单超过这个时间没取到过就自动拉一次
const LIST_RETRY_MS = 30 * 60 * 1000;       // 失败后的最小重试间隔：避免每次 SW 唤醒都重打一遍候选源
const LIST_DELETE_MS = 24 * 3600 * 1000;    // 镜像连续缺失超过这个时间才从列表移除（抗抖动）

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

// DNR 的更新是"先全删再全加"，两个调用交错会让规则短暂丢失或 id 冲突，
// 所以所有重建排队执行。
let applyChain = Promise.resolve();

function applyRules() {
  applyChain = applyChain.then(doApplyRules, doApplyRules);
  return applyChain;
}

async function doApplyRules() {
  const settings = await getSettings();
  const active = await isActiveNow(settings);
  const mirrors = await getMirrors();
  const want = active ? MFL.buildRules(mirrors, settings) : [];

  const existing = await ext.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map(r => r.id);
  await ext.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: want });

  const best = MFL.chooseMirrors(mirrors, settings);
  const brief = m => (m ? { name: m.name, base: m.base, score: m.score, host: MFL.hostOf(m.base) } : null);
  const useArchive = !!(settings.codeload && settings.codeload.enabled);
  const primary = active ? brief(best.primary) : null;
  const archive = active && useArchive ? brief(best.archive) : null;

  setBadge(active ? (want.length ? 'ON' : '!') : '', active ? (want.length ? '#1a7f37' : '#b54708') : '#6b7280');
  dbg('rules', '规则重建完成', {
    count: want.length, active, split: !!best.split,
    best: primary && primary.base, archive: archive && archive.base,
  });
  await ext.storage.local.set({
    ruleInfo: {
      count: want.length,
      active,
      best: want.length ? primary : null,
      archive: want.length ? archive : null,
      split: !!best.split,
      updatedAt: Date.now(),
    },
  });
  return { count: want.length, active, best: primary, archive };
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
  const mirrors = await getMirrors();
  const targets = mirrors.filter(m => m.enabled);
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

/** 从远程 JSON 里取镜像数组；形状不认识就返回 null（绝不悄悄折成空数组） */
function pickIncoming(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data.mirrors)) return data.mirrors;
  return null;
}

async function fetchRemoteList() {
  const settings = await getSettings();
  const cfg = settings.remoteList || {};
  if (!cfg.enabled) { dbg('list', '远程清单未启用，直接返回'); return { ok: false, reason: 'not-enabled' }; }

  // 地址留空就用默认（仓库里的 mirrors.json），不用手填
  const rawUrl = String(cfg.url || MFL.DEFAULT_SETTINGS.remoteList.url).trim();
  if (!rawUrl) return { ok: false, reason: 'no-url' };
  // 记「尝试时间」：失败也要记，否则每次 SW 唤醒都会重新串行重试所有候选源
  await ext.storage.local.set({ [K.listAttempt]: Date.now() });
  dbg('list', '开始获取远程清单', { url: rawUrl, enabled: cfg.enabled });

  const mirrors = await getMirrors();
  const candidates = [];
  mirrors.filter(m => m.enabled && m.permitted).sort((a, b) => (b.score || 0) - (a.score || 0))
    .forEach(m => candidates.push({ via: m.name, url: String(m.base).replace(/\/+$/, '') + '/' + rawUrl }));
  candidates.push({ via: '直连', url: rawUrl });

  const tried = [];
  dbg('list', '候选来源', candidates.map(c => c.via));
  for (const c of candidates) {
    try {
      const res = await fetch(c.url, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10000) });
      if (!res.ok) {
        tried.push({ via: c.via, err: 'HTTP ' + res.status });
        dbg('list', '清单来源失败', { via: c.via, err: 'HTTP ' + res.status, url: c.url });
        continue;
      }
      const data = await res.json();
      const r = await applyRemoteList(data);
      if (r.skipped === 'bad-shape') {
        // 形状不认识（比如把 git.mxg.pub 的 {data:[...]} 直接填成清单地址）：
        // 当作这次来源失败，换下一个候选，绝不按「空清单」去删镜像
        tried.push({ via: c.via, err: '清单格式无法识别' });
        dbg('list', '清单格式无法识别', { via: c.via, url: c.url });
        continue;
      }
      await ext.storage.local.set({
        [K.listFetched]: { at: Date.now(), via: c.via, added: r.added, removed: r.removed, ok: true },
      });
      await applyRules();
      dbg('list', '清单获取成功', { via: c.via, added: r.added, removed: r.removed });
      return { ok: true, via: c.via, added: r.added, removed: r.removed };
    } catch (e) {
      // 把每个来源的失败原因带回去，界面才能说清是哪一步挂了
      const why = (e && e.name === 'TimeoutError') ? '超时'
        : (e && (e.name === 'SyntaxError' || /JSON/i.test(String(e.message)))) ? '返回的不是 JSON'
          : '连接失败';
      tried.push({ via: c.via, err: why });
      dbg('list', '清单来源失败', { via: c.via, err: why, detail: String(e && e.message ? e.message : e).slice(0, 120), url: c.url });
    }
  }
  await ext.storage.local.set({ [K.listFetched]: { at: Date.now(), via: '', added: 0, ok: false, tried } });
  dbg('list', '清单全部失败', tried);
  return { ok: false, reason: 'all-failed', tried };
}

/** 到期才刷新远程清单：距上次成功获取超过 24h 才真的去拉；失败后至少等 30min 再重试 */
async function maybeRefreshList(force) {
  const settings = await getSettings();
  const cfg = settings.remoteList || {};
  const url = String(cfg.url || MFL.DEFAULT_SETTINGS.remoteList.url).trim();
  if (!cfg.enabled || !url) return { ok: false, skipped: 'disabled' };

  const o = await ext.storage.local.get([K.listFetched, K.listAttempt]);
  const lf = o[K.listFetched];
  const last = (lf && lf.ok ? lf.at : 0) || 0;   // 只认「成功」的时间：失败不压制重试
  if (!force && Date.now() - last < LIST_REFRESH_MS) {
    dbg('list', '周期巡检：清单仍是新的，跳过', { 距今小时: Math.round((Date.now() - last) / 3600000) });
    return { ok: false, skipped: 'fresh' };
  }
  // 失败退避：bootstrap 在每次 SW 唤醒都会跑一遍，没有这个间隔就会一直串行重试所有候选源
  const lastTry = o[K.listAttempt] || 0;
  if (!force && lastTry && Date.now() - lastTry < LIST_RETRY_MS) {
    dbg('list', '周期巡检：距上次尝试不足 30min，退避中');
    return { ok: false, skipped: 'backoff' };
  }

  return runListFetch();
}

/** 同一时刻只允许一次清单拉取（bootstrap / 定时器 / 手动点击可能撞在一起） */
let listInFlight = null;
function runListFetch() {
  if (listInFlight) return listInFlight;
  listInFlight = fetchRemoteList().finally(() => { listInFlight = null; });
  return listInFlight;
}

/** 应用远程清单：增 + 删（24h 迟滞，避免偶发抖动误删） */
async function applyRemoteList(data) {
  const incoming = pickIncoming(data);
  // 形状不认识 → 明确报错，让上层换下一个候选源；不能折成空数组（那会触发 24h 删除）
  if (!incoming) return { added: 0, removed: 0, skipped: 'bad-shape' };
  const settings = await getSettings();
  const rl = settings.remoteList || {};
  const cur = await getMirrors();
  const o = await ext.storage.local.get(K.listMissing);
  const res = MFL.syncMirrors(cur, incoming, {
    allowDelete: rl.allowDelete !== false,
    deleteAfterMs: LIST_DELETE_MS,
  }, Date.now(), o[K.listMissing] || {});
  if (res.added || res.removed) await setMirrors(res.list);
  await ext.storage.local.set({ [K.listMissing]: res.missing });
  return { added: res.added, removed: res.removed };
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
  if (!ext.downloads || !ext.downloads.download) {
    DBG.log('task', '浏览器没有 downloads API');
    return { ok: false, reason: 'no-downloads-api' };
  }

  const name = safeFileName(task.name);
  if (!name) { DBG.log('task', '文件名非法', task.name); return { ok: false, reason: 'bad-name' }; }

  let made;
  try { made = makeTaskUrl(task); } catch { return { ok: false, reason: 'encode-failed' }; }

  dbg('task', '准备写任务文件', {
    name, filename: TASK_FOLDER + '/' + name + '.task.json',
    expected: task.expected || null, source: task.source || '', scheme: made.url.slice(0, 12),
  });

  try {
    const id = await ext.downloads.download({
      url: made.url,
      filename: TASK_FOLDER + '/' + name + '.task.json',
      conflictAction: 'overwrite',
      saveAs: false,
    });
    DBG.log('task', '任务文件已写入', { id, path: TASK_FOLDER + '/' + name + '.task.json', scheme: made.url.slice(0, 12) });
    // 从下载列表移除记录（只清历史，不删文件），避免每次下载都留痕
    setTimeout(() => { try { ext.downloads.erase({ id }); } catch { } }, 2000);
    if (made.revoke) setTimeout(() => { try { URL.revokeObjectURL(made.url); } catch { } }, 3000);

    await ext.storage.local.set({ lastTask: { name, at: Date.now(), ok: true } });
    return { ok: true, id, name };
  } catch (e) {
    const why = String(e && e.message ? e.message : e);
    DBG.log('task', '任务文件写入失败', why);
    return { ok: false, reason: why };
  }
}

/** 点击下载时调用：记意图 → 尽力取期望哈希 → 写任务文件交给脚本校验 */
async function createVerifyTask(rawUrl, name) {
  // 下载器/镜像页传来的可能是 https://<mirror>/https://github.com/... ，
  // 先还原成官方直链，否则取期望哈希和回源锚点都会失败。
  const url = MFL.normalizeGitHubUrl(String(rawUrl || ''));
  const settings = await getSettings();
  DBG.log('intent', '创建任务', { url, restored: url !== rawUrl, name, hash: settings.hash });
  if (!settings.hash || !settings.hash.enabled || !settings.hash.auto) {
    DBG.log('intent', '跳过：哈希校验未开启', settings.hash);
    return { ok: false, skipped: 'disabled' };
  }

  const finalName = name || AH.nameFromUrl(url);
  if (!finalName) { DBG.log('intent', '跳过：拿不到文件名'); return { ok: false, reason: 'no-name' }; }

  await recordIntent(url, finalName);

  let expected = null;
  let source = '';
  let meta = { repo: '', tag: '', assetId: 0, size: 0, sourceKind: '' };
  const permitted = await hasApiPermission();
  DBG.log('intent', 'api.github.com 权限', { permitted });
  if (permitted) {
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
      DBG.log('intent', '取到期望哈希', {
        hasHash: !!expected, sourceKind: meta.sourceKind, repo: meta.repo, tag: meta.tag,
        assetId: meta.assetId, size: meta.size, source,
      });
    } catch (e) {
      source = '未取得：' + String(e && e.message ? e.message : e).slice(0, 60);
      DBG.log('intent', '取哈希失败', source);
    }
  } else {
    source = '未授权 api.github.com';
    DBG.log('intent', '没有 api.github.com 权限，任务里不会有期望值');
  }

  return writeTaskFile(Object.assign({
    v: 2, name: finalName, url, expected, source, ts: Date.now(),
  }, meta));
}

/* --------------------------------- 定时器 -------------------------------- */

async function syncAlarms() {
  const settings = await getSettings();
  const wantProbe = (settings.probeMode === 'interval' && settings.enabled)
    ? Math.max(15, Math.min(1440, settings.probeIntervalMin || 60))
    : 0;

  // 只在"缺失或周期变了"时重建：Service Worker 每次唤醒都会走一遍 bootstrap，
  // 无条件 create 会把定时器一直往后推，间隔探测可能永远等不到。
  const cur = await ext.alarms.get(ALARM_PROBE);
  if (!wantProbe) {
    if (cur) await ext.alarms.clear(ALARM_PROBE);
  } else if (!cur || cur.periodInMinutes !== wantProbe) {
    await ext.alarms.create(ALARM_PROBE, { periodInMinutes: wantProbe });
  }

  const tick = await ext.alarms.get(ALARM_TICK);
  if (!tick) await ext.alarms.create(ALARM_TICK, { periodInMinutes: 5 });

  // 远程清单：开启就排期（地址留空会回落到默认地址），每 12 小时探一次；真正的刷新由 24h 闸门决定
  const wantList = !!(settings.remoteList && settings.remoteList.enabled);
  const curList = await ext.alarms.get(ALARM_LIST);
  if (!wantList) {
    if (curList) await ext.alarms.clear(ALARM_LIST);
  } else if (!curList || curList.periodInMinutes !== 720) {
    await ext.alarms.create(ALARM_LIST, { periodInMinutes: 720 });
  }
}

ext.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === ALARM_PROBE) {
    const s = await getSettings();
    if (!(await isActiveNow(s))) return;
    await probeAll('interval');
  } else if (alarm.name === ALARM_TICK) {
    // 生效时段边界：每 5 分钟校正一次规则状态
    await applyRules();
  } else if (alarm.name === ALARM_LIST) {
    maybeRefreshList(false).catch(() => {});
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
    const prev = await getSettings();
    const next = await setSettings(msg.patch || {});
    // 启用远程清单时，「允许删除镜像」默认打开（显式 false 才关）
    if (next.remoteList && next.remoteList.enabled && next.remoteList.allowDelete === undefined) {
      next.remoteList.allowDelete = true;
      await setSettings({ remoteList: next.remoteList });
    }
    // 换清单地址 / 关掉远程清单：把「缺失计时」和上次获取记录一起清掉，
    // 否则新清单的第一轮会被上一份清单留下的缺失记录连累，提前被判「已连续缺失」
    const prevUrl = String((prev.remoteList && prev.remoteList.url) || '');
    const nextUrl = String((next.remoteList && next.remoteList.url) || '');
    const turnedOff = !(next.remoteList && next.remoteList.enabled);
    if (prevUrl !== nextUrl || turnedOff) {
      await ext.storage.local.remove([K.listMissing, K.listFetched, K.listAttempt]);
      dbg('list', '清单配置变化，已重置缺失计时与获取记录', { prevUrl, nextUrl, turnedOff });
    }
    await syncAlarms();
    await applyRules();
    // 只在用户真的改了远程清单配置时顺带拉一次。以前只要改 token / 任意开关
    // 都会触发网络请求，容易出现莫名其妙的「获取失败」。
    if (msg.patch && msg.patch.remoteList && next.remoteList && next.remoteList.enabled) {
      dbg('list', '远程清单配置变更，顺带拉一次');
      maybeRefreshList(false).catch(() => {});
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
    const list = await getMirrors();
    // 优先按 base 精确匹配（id 由 host 派生，a-b.com 与 a.b.com 会撞车）；否则按 id 只删第一条
    let idx = msg.base ? list.findIndex(m => MFL.normalizeBase(m.base) === MFL.normalizeBase(msg.base)) : -1;
    if (idx < 0) idx = list.findIndex(m => m.id === msg.id);
    if (idx >= 0) {
      const h = MFL.hostOf(list[idx].base);
      list.splice(idx, 1);
      await setMirrors(list);
      // 顺手清掉这个 host 的缺失计时，避免 storage 里留无主记录
      if (h) {
        const o = await ext.storage.local.get(K.listMissing);
        const miss = o[K.listMissing] || {};
        if (miss[h]) { delete miss[h]; await ext.storage.local.set({ [K.listMissing]: miss }); }
      }
    } else {
      await setMirrors(list);
    }
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
  'fetch-list': async () => runListFetch(),
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
      // 拆开给内容脚本记日志：只给一个 hashAuto:false 说不清到底缺哪一项
      hash: {
        enabled: !!(settings.hash && settings.hash.enabled),
        auto: !!(settings.hash && settings.hash.auto),
        hasToken: !!String(settings.token || '').trim(),
      },
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
    const url = MFL.normalizeGitHubUrl(String(msg.url));
    return writeTaskFile({
      v: 2, name: msg.name || AH.nameFromUrl(url), url,
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

// 轮询类消息每隔几秒就来一次，记进日志只会淹没真正的操作
const QUIET_MSG = new Set(['get-state', 'hash-state', 'badge-info', 'maybe-probe', 'sync-alarms']);

function briefResult(r) {
  if (!r || typeof r !== 'object') return { value: r };
  const out = {};
  for (const k of ['ok', 'reason', 'error', 'skipped', 'count', 'added', 'probed', 'via', 'active', 'id']) {
    if (r[k] !== undefined) out[k] = r[k];
  }
  if (r.rules && r.rules.count !== undefined) out.rules = r.rules.count;
  if (r.tried) out.tried = r.tried.length;
  return out;
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg && msg.type;
  const loud = !!type && !QUIET_MSG.has(type);
  if (loud) dbg('msg', '后台收到 ' + type, {
    from: sender && sender.tab ? 'tab:' + sender.tab.id : 'ext',
    url: msg.url ? String(msg.url).slice(0, 120) : undefined,
    patch: msg.patch || undefined,
  });
  const fn = handlers[type];
  if (!fn) return false;
  Promise.resolve(fn(msg, sender))
    .then(r => {
      if (loud) dbg('msg', '后台返回 ' + type, briefResult(r));
      sendResponse(r);
    })
    .catch(e => {
      const err = String(e && e.message ? e.message : e);
      if (loud) dbg('msg', '后台异常 ' + type, err);
      sendResponse({ ok: false, error: err });
    });
  return true;   // 异步响应
});

/* ---------------------------- 下载事件（诊断） ----------------------------
 * 关键：任务文件到底落在哪个目录，扩展自己说了不算，浏览器给的真实路径才算。
 * 如果这里出现的是浏览器默认下载目录、而不是脚本实际扫描的目录，任务就会匹配不上。
 */
const DEBUG_ON = (typeof DBG !== 'undefined' && DBG.enabled);
if (DEBUG_ON && ext.downloads && ext.downloads.onCreated) {
  ext.downloads.onCreated.addListener(item => {
    // DNR 重定向后下载项里可能已经是镜像 URL，这里顺手验证还原是否成功
    const raw = String(item.url || '');
    const gh = MFL.normalizeGitHubUrl(raw);
    dbg('download', '浏览器发起下载', {
      id: item.id,
      url: raw.slice(0, 140),
      restored: gh !== raw,
      ghUrl: gh !== raw ? gh.slice(0, 140) : undefined,
      filename: item.filename || '',
      mime: item.mime || '',
    });
  });
}
if (DEBUG_ON && ext.downloads && ext.downloads.onChanged) {
  ext.downloads.onChanged.addListener(delta => {
    if (delta.filename) dbg('download', '下载落盘路径', { id: delta.id, filename: delta.filename.current });
    if (delta.state) dbg('download', '下载状态 ' + delta.state.current, { id: delta.id });
    if (delta.error) dbg('download', '下载失败 ' + delta.error.current, { id: delta.id });
  });
}

/* --------------------------------- 生命周期 ------------------------------- */

async function bootstrap() {
  dbg('boot', '后台启动/唤醒', {
    version: ext.runtime.getManifest().version,
    debug: !!(ext.runtime.getManifest().debug),
  });
  // 首次安装时把默认设置落盘，避免 storage 里没有 settings 键
  const raw = await ext.storage.local.get(K.settings);
  if (!raw[K.settings]) {
    await ext.storage.local.set({ [K.settings]: JSON.parse(JSON.stringify(MFL.DEFAULT_SETTINGS)) });
  }
  await seedMirrors();
  await refreshPermissions();
  await syncAlarms();
  await applyRules();
  // 浏览器启动时顺带检查一次远程清单是否过期（被 24h 闸门挡着，不会每次都拉）
  maybeRefreshList(false).catch(() => {});
}

ext.runtime.onInstalled.addListener(() => { bootstrap().catch(() => {}); });
ext.runtime.onStartup.addListener(() => { bootstrap().catch(() => {}); });
bootstrap().catch(() => {});
