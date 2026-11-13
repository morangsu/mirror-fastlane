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
  ruleFingerprint: 'ruleFingerprint',
  rawSample: 'rawSample',       // 最近 N 条「看得到结果」的 raw 请求
  rawPending: 'rawPending',     // 已发起、还没结算的 raw 请求（跨 SW 唤醒保留）
  rawReprobeAt: 'rawReprobeAt', // 上次因失败率触发重测的时间（冷却）
  rawUnknown: 'rawUnknown',     // 观测不到结果的次数（多半是镜像域名没授权）
  dlFailures: 'dlFailures',     // 真实下载失败计数（按 host）
  removedBuiltin: 'removedBuiltin', // 用户手动删掉的内置镜像（host → ts），升级补齐时跳过
};

const PROBE_TIMEOUT_MS = 12000;
const PROBE_RAW_TIMEOUT_MS = 6000;   // raw 是小文件，6 秒足够；超时只影响这一个分片
const PROBE_BYTES = 65536;           // 64 KB/镜像：一轮全量约 1.1 MB，比原来的 4.3 MB 省 4 倍
// 同时探测几个镜像：3 → 6。17 条全量从 ~6 轮降到 ~3 轮；峰值带宽 6×64 KB=384 KB，
// 仍低于旧版 3×256 KB=768 KB，对镜像的压力反而更小。慢镜像/坏镜像不再逐个排队拖时间。
const PROBE_CONCURRENCY = 6;
const PROBE_ROTATE_MAX = 6;          // 非手动探测每轮最多测这几个「最久没测」的，其余沿用旧数据
const PROBE_GAP_MS = 30 * 60 * 1000;   // 按需探测的最小间隔
const ALARM_PROBE = 'mfl-probe';
const ALARM_TICK = 'mfl-tick';
const ALARM_LIST = 'mfl-list';
const LIST_REFRESH_MS = 24 * 3600 * 1000;   // 远程清单超过这个时间没取到过就自动拉一次
const LIST_RETRY_MS = 30 * 60 * 1000;       // 失败后的最小重试间隔：避免每次 SW 唤醒都重打一遍候选源
const LIST_DELETE_MS = 24 * 3600 * 1000;    // 镜像连续缺失超过这个时间才从列表移除（抗抖动）
const RAW_SAMPLE_WINDOW_MS = 30 * 60 * 1000;
const RAW_PENDING_TTL_MS = 20000;           // 发起后 20s 还没结果 → 记为「无法观测」，不算进分母
const RAW_PENDING_MAX = 40;
const DL_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

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

/**
 * 镜像表的所有读-改-写都排队，且 fn 拿到的是「开始执行时」的最新列表。
 * 以前探测会先读一份快照、几十秒后整表写回，用户在这期间关掉的开关、删掉的镜像会被静默回滚
 * （CDP 复现：enabled_right_after_toggle=false → enabled_after_probe=true）。
 */
let mirrorChain = Promise.resolve();
function mutateMirrors(fn) {
  const run = mirrorChain.then(async () => {
    const list = await getMirrors();
    const next = await fn(list);
    if (next && Array.isArray(next)) await setMirrors(next);
    return next && Array.isArray(next) ? next : list;
  });
  mirrorChain = run.catch(() => {});   // 一次失败不阻断后续写入
  return run;
}

/**
 * 内置清单落盘。
 * 以前只在「列表为空」时灌一次，结果老用户升级后永远停在安装时的快照
 * （Edge 装了旧版就比 Firefox 新装少几条）。现在改为**补齐缺失项**：
 *  - 已存在的 host 一律跳过（保留用户改名 / 停用 / 测速结果）
 *  - 用户手动删过的内置镜像记在 removedBuiltin 墓碑里，不再复活
 */
async function seedMirrors() {
  // 走同一条队列：首次安装时用户可能已经打开设置页触发 refreshPermissions，
  // 直接 setMirrors 会与它互相覆盖。
  return mutateMirrors(async list => {
    let data;
    try {
      const r = await fetch(ext.runtime.getURL('data/builtin-mirrors.json'));
      data = await r.json();
    } catch {
      return undefined;   // 读不到内置清单就什么都不做，绝不清空
    }
    const builtin = (data.mirrors || [])
      .map(m => ({ raw: m, base: MFL.normalizeBase(m.base) }))
      .filter(x => !!x.base);
    if (!builtin.length) return undefined;

    const o = await ext.storage.local.get(K.removedBuiltin);
    const removed = o[K.removedBuiltin] || {};
    const builtinHosts = new Set(builtin.map(x => MFL.hostOf(x.base)));

    // 清掉已经不在内置清单里的墓碑（清单更新后旧 host 不再需要记）
    let tombChanged = false;
    Object.keys(removed).forEach(h => {
      if (!builtinHosts.has(h)) { delete removed[h]; tombChanged = true; }
    });

    const have = new Set(list.map(m => MFL.hostOf(m.base)));
    const adds = [];
    builtin.forEach(({ raw: m, base }) => {
      const h = MFL.hostOf(base);
      if (!h || have.has(h) || removed[h]) return;
      have.add(h);
      adds.push({
        id: MFL.idFromBase(base),
        name: m.name || h,
        base,
        enabled: true,
        source: 'builtin',
        note: m.note || '',
        seedKbps: m.seedKbps || 0,
        healthy: true,
        permitted: false,
        stats: { kbps: 0, ttfb: 0, failures: 0, lastProbe: 0, lastError: '' },
        rawStats: { ttfb: 0, failures: 0, lastProbe: 0, lastError: '' },
        score: 0,
      });
    });

    if (tombChanged) await ext.storage.local.set({ [K.removedBuiltin]: removed });
    dbg('seed', '内置清单补齐', { builtin: builtin.length, existing: list.length, added: adds.length });
    return adds.length ? list.concat(adds) : undefined;
  });
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

function applyRules(force) {
  applyChain = applyChain.then(() => doApplyRules(force), () => doApplyRules(force));
  return applyChain;
}

async function doApplyRules(force) {
  const settings = await getSettings();
  const active = await isActiveNow(settings);
  const mirrors = await getMirrors();
  // Chrome 只对「扩展有 host 权限的请求 URL」应用 redirect，raw 是可选权限，得先确认拿到
  const rawAllowed = !!(active && settings.raw && settings.raw.enabled &&
    await hasPermission('https://raw.githubusercontent.com'));
  const want = active ? MFL.buildRules(mirrors, settings, { rawAllowed }) : [];
  const fp = MFL.fingerprintRules(want, active);

  try {
    // SW 每次唤醒都会跑到这里。规则没变就别再「全删全加」一次 DNR（还会写 storage）。
    const cache = await ext.storage.local.get(K.ruleFingerprint);
    let unchanged = !force && cache[K.ruleFingerprint] === fp;
    if (unchanged) {
      // 指纹只证明「我们要的规则没变」，不能证明「浏览器里还留着这些规则」：
      // 浏览器更新、外部清空、上一次写入部分失败之后指纹仍匹配，会永远不重建。
      // 用一次轻量查询兜底（~1ms，比全删全加重建便宜一个数量级）。
      const cur = await ext.declarativeNetRequest.getDynamicRules();
      if (cur.length !== want.length) unchanged = false;
    }
    if (!unchanged) {
      const existing = await ext.declarativeNetRequest.getDynamicRules();
      await ext.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existing.map(r => r.id), addRules: want,
      });
      await ext.storage.local.set({ [K.ruleFingerprint]: fp });
    }

    const best = MFL.chooseMirrors(mirrors, settings);
    const brief = m => (m ? { name: m.name, base: m.base, score: m.score, host: MFL.hostOf(m.base) } : null);
    const useArchive = !!(settings.codeload && settings.codeload.enabled);
    const primary = active ? brief(best.primary) : null;
    const archive = active && useArchive ? brief(best.archive) : null;
    const rawShards = (active && rawAllowed && settings.raw && settings.raw.enabled)
      ? MFL.pickRawMirrors(mirrors, MFL.RAW_REGEXES.length)
        .map((m, i) => ({ i, name: m.name, host: MFL.hostOf(m.base) }))
      : [];

    setBadge(active ? (want.length ? 'ON' : '!') : '', active ? (want.length ? '#1a7f37' : '#b54708') : '#6b7280');
    dbg('rules', '规则重建完成', {
      count: want.length, active, split: !!best.split, unchanged,
      best: primary && primary.base, archive: archive && archive.base,
    });
    await ext.storage.local.set({
      ruleInfo: {
        count: want.length,
        active,
        best: want.length ? primary : null,
        archive: want.length ? archive : null,
        raw: want.length ? rawShards : [],
        split: !!best.split,
        error: '',
        unchanged: !!unchanged,
        updatedAt: Date.now(),
      },
    });
    return { count: want.length, active, best: primary, archive, unchanged: !!unchanged };
  } catch (e) {
    // 以前 updateDynamicRules 一抛错，徽章与 ruleInfo 都不更新，界面还停在「生效中」，
    // 实际规则是 0 条。现在明确写 error，设置页会显示红字。
    const err = String(e && e.message ? e.message : e);
    setBadge('!', '#cf222e');
    dbg('rules', '规则重建失败', err);
    await ext.storage.local.set({
      ruleInfo: {
        count: 0, active, best: null, archive: null, raw: [], split: false,
        error: err, unchanged: false, updatedAt: Date.now(),
      },
    });
    return { ok: false, error: err, count: 0, active };
  }
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
  let html = false;
  let sniffed = false;
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-' + (PROBE_BYTES - 1) },
      signal: ctrl.signal,
      cache: 'no-store',
      redirect: 'follow',
      credentials: 'omit',
    });
    status = res.status;
    // 200 的 HTML 错误页/限流页不是文件；只判「有字节」会让它因传得快而排到第一
    html = /text\/html/i.test(res.headers.get('content-type') || '');
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!ttfb) ttfb = performance.now() - t0;
        // content-type 不可靠：有些镜像把 HTML 错误页标成 text/plain。首块以 '<' 开头也算错误页
        if (!sniffed && value && value.byteLength) {
          sniffed = true;
          try {
            const head = new TextDecoder().decode(value.subarray(0, 64)).trimStart();
            if (head.startsWith('<')) html = true;
          } catch { /* 解码失败就当二进制 */ }
        }
        bytes += value.byteLength;
        if (bytes >= PROBE_BYTES) { try { await reader.cancel(); } catch {} break; }
      }
    }
    const total = performance.now() - t0;
    const transfer = Math.max(total - ttfb, 1);
    const kbps = bytes / 1024 / (transfer / 1000);
    return { status, bytes, ttfb: ttfb || total, kbps, html };
  } catch (e) {
    const timeout = e && e.name === 'AbortError';
    // 超时但已经读到足够字节：链路是通的，只是没读满。算「部分成功」，
    // 速度数据偏低会让它自然降权，不该直接判死。
    if (timeout && bytes >= MFL.PROBE_MIN_BYTES) {
      const total = performance.now() - t0;
      const kbps = bytes / 1024 / Math.max(total - ttfb, 1) * 1000;
      return { status, bytes, ttfb: ttfb || total, kbps, html, partial: true, reason: 'timeout-partial' };
    }
    return { error: true, reason: timeout ? 'timeout' : 'fetch-failed', status, bytes, html };
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
      // 只有 release 探通了才有资格当 raw 分片，省掉一轮无谓请求
      const raw = MFL.evaluateProbe(r).ok ? await probeRawOne(m) : null;
      out.push({ mirror: m, permitted: true, result: r, raw });
    }
  });
  await Promise.all(workers);
  return out;
}

/** raw 小文件探测：只看能不能拿到内容与首字节时间 */
async function probeRawOne(mirror) {
  const base = String(mirror.base || '').replace(/\/+$/, '');
  const url = base + '/' + MFL.RAW_PROBE_URL;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_RAW_TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store', redirect: 'follow', credentials: 'omit' });
    if (res.status !== 200) return { error: true, reason: 'http-' + res.status };
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 200) return { error: true, reason: 'empty' };   // 挡住 HTML 错误页
    return { ttfb: Math.round(performance.now() - t0), bytes: buf.byteLength };
  } catch (e) {
    return { error: true, reason: (e && e.name === 'AbortError') ? 'timeout' : 'fetch-failed' };
  } finally {
    clearTimeout(timer);
  }
}

/** 把一次 raw 探测结果并入 rawStats（null 表示没测，保留旧值） */
function nextRawStats(prev, raw) {
  const p = prev || { ttfb: 0, failures: 0, lastProbe: 0, lastError: '' };
  if (!raw) return p;
  if (raw.error) {
    return { ttfb: 0, failures: (p.failures || 0) + 1, lastProbe: Date.now(), lastError: raw.reason || 'error' };
  }
  return { ttfb: raw.ttfb || 0, failures: 0, lastProbe: Date.now(), lastError: '' };
}

async function probeAll(reason, onlyIds) {
  const settings = await getSettings();
  const mirrors = await getMirrors();
  // onlyIds 给了就只测这些（比如刚授权的一批），避免把整张表重测一遍
  const want = (onlyIds && onlyIds.length) ? new Set(onlyIds) : null;
  let targets = mirrors.filter(m => m.enabled && (!want || want.has(m.id)));

  if (!want && reason !== 'manual') {
    // probeCacheHours 以前只是个没人读的死设置：按时/按需探测跳过缓存期内已测过且健康的，
    // 再按「最久没测」轮转，每轮最多 PROBE_ROTATE_MAX 个 → 流量从 4.3 MB 降到 ~0.4 MB。
    const cacheHours = Math.max(0, Math.min(24, Number(settings.probeCacheHours) || 0));
    const cacheMs = cacheHours * 3600 * 1000;
    if (cacheMs) {
      targets = targets.filter(m => !(m.stats && m.stats.lastProbe &&
        Date.now() - m.stats.lastProbe < cacheMs && m.healthy));
    }
    targets.sort((a, b) => ((a.stats && a.stats.lastProbe) || 0) - ((b.stats && b.stats.lastProbe) || 0));
    if (targets.length > PROBE_ROTATE_MAX) targets = targets.slice(0, PROBE_ROTATE_MAX);
  }
  if (!targets.length) return { probed: 0, skipped: 'fresh-or-cached' };

  const results = await runProbe(targets, PROBE_CONCURRENCY);
  const map = new Map(results.map(r => [r.mirror.id, r]));
  const probedAt = Date.now();

  // 用「执行时」的最新列表合并，且只覆盖探测相关字段：
  // 用户在这几十秒里停用/删除/改名的镜像不会被旧快照写回来，也不会被重新加回来。
  await mutateMirrors(latest => latest.map(m => {
    const r = map.get(m.id);
    if (!r) return m;
    if (!r.permitted) {
      return Object.assign({}, m, { permitted: false, stats: Object.assign({}, m.stats, { lastError: '未授权，无法测速' }) });
    }
    const verdict = MFL.evaluateProbe(r.result);
    const fail = verdict.ok ? 0 : ((m.stats && m.stats.failures) || 0) + 1;
    return Object.assign({}, m, {
      healthy: fail < 3,
      rawStats: nextRawStats(m.rawStats, r.raw),
      stats: {
        kbps: verdict.ok ? Math.round(r.result.kbps) : 0,
        ttfb: verdict.ok ? Math.round(r.result.ttfb) : 0,
        failures: fail,
        lastProbe: probedAt,
        lastError: verdict.ok ? '' : verdict.reason,
      },
    });
  }));

  const rules = await applyRules();
  if (reason !== 'silent') {
    await ext.storage.local.set({ lastProbe: probedAt });
  }
  return { probed: results.length, rules };
}

/** 只重测 raw 分片（2 KB 小文件，比整轮 release 探测便宜两个数量级） */
async function probeRawAll(reason) {
  const mirrors = await getMirrors();
  const candidates = MFL.pickRawMirrors(mirrors, 12).filter(m => m.enabled && m.healthy);
  const allowed = [];
  for (const m of candidates) {
    if (await hasPermission(m.base)) allowed.push(m);
  }
  // raw 探测也是 2 KB 小文件，限制同样的并发，别一次打 12 个
  const results = [];
  for (let i = 0; i < allowed.length; i += PROBE_CONCURRENCY) {
    const batch = allowed.slice(i, i + PROBE_CONCURRENCY);
    results.push(...await Promise.all(batch.map(async m => ({ id: m.id, raw: await probeRawOne(m) }))));
  }
  const map = new Map(results.map(r => [r.id, r.raw]));
  await mutateMirrors(latest => latest.map(m => map.has(m.id)
    ? Object.assign({}, m, { rawStats: nextRawStats(m.rawStats, map.get(m.id)) })
    : m));
  const rules = await applyRules();
  dbg('raw', 'raw 分片重测完成', { reason, probed: results.length, rules: rules && rules.count });
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
  // github.com 已在必需 host 权限里，页面形态的 raw 地址可作为最后一道兜底；
  // 它会 302 回 raw.githubusercontent.com，没拿到那个可选权限时可能失败，所以不承诺成功。
  const pageUrl = rawUrl.replace(
    /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(.+)$/,
    'https://github.com/$1/$2/raw/$3');
  if (pageUrl !== rawUrl) candidates.push({ via: 'GitHub 页面直链', url: pageUrl });

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
  let res;
  // 与探测/用户操作排队，避免拿旧快照整表写回
  await mutateMirrors(async cur => {
    const o = await ext.storage.local.get(K.listMissing);
    res = MFL.syncMirrors(cur, incoming, {
      allowDelete: rl.allowDelete !== false,
      deleteAfterMs: LIST_DELETE_MS,
    }, Date.now(), o[K.listMissing] || {});
    return (res.added || res.removed) ? res.list : undefined;
  });
  // 新加的镜像可能已被「所有网站」这类授权覆盖，立刻按浏览器真实状态校正一次
  if (res.added) await refreshPermissions();
  await ext.storage.local.set({ [K.listMissing]: res.missing });
  return { added: res.added, removed: res.removed };
}

/* ------------------------------- 权限同步 ------------------------------- */

async function refreshPermissions() {
  return mutateMirrors(async list => {
    let changed = false;
    for (const m of list) {
      const ok = await hasPermission(m.base);
      if (m.permitted !== ok) { m.permitted = ok; changed = true; }
    }
    return changed ? list : undefined;
  });
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

  // 5 分钟 tick 只用于「生效时段边界校正」。默认配置（时段关闭）下它是纯空转：
  // 每天 288 次唤醒 SW 只为跑一遍规则重建。没开时段就别创建。
  const wantTick = !!(settings.enabled && settings.activeWindow && settings.activeWindow.enabled);
  const tick = await ext.alarms.get(ALARM_TICK);
  if (!wantTick) {
    if (tick) await ext.alarms.clear(ALARM_TICK);
  } else if (!tick) {
    await ext.alarms.create(ALARM_TICK, { periodInMinutes: 5 });
  }

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
  const o = await ext.storage.local.get([
    K.lastProbe, K.listFetched, 'ruleInfo',
    K.rawSample, K.rawReprobeAt, K.rawUnknown, K.dlFailures,
  ]);
  return {
    settings,
    mirrors,
    lastProbe: o[K.lastProbe] || 0,
    listFetched: o[K.listFetched] || null,
    ruleInfo: o.ruleInfo || { count: 0, active: false, best: null, error: '' },
    rawStats: {
      samples: o[K.rawSample] || [],
      lastReprobeAt: o[K.rawReprobeAt] || 0,
      // 兼容旧格式（纯数字）与新的窗口计数；超过 30 分钟视为 0
      unknown: (() => {
        const u = o[K.rawUnknown];
        if (typeof u === 'number') return u;
        return (u && Date.now() - (u.at || 0) < RAW_SAMPLE_WINDOW_MS) ? (u.n || 0) : 0;
      })(),
    },
    dlFailures: o[K.dlFailures] || {},
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
    let duplicate = false;
    await mutateMirrors(async cur => {
      if (cur.some(m => MFL.hostOf(m.base) === MFL.hostOf(base))) { duplicate = true; return undefined; }
      return cur.concat([{
        id: MFL.idFromBase(base),
        name: msg.name || MFL.hostOf(base),
        base,
        enabled: true,
        source: 'user',
        note: '',
        healthy: true,
        permitted: await hasPermission(base),   // 以浏览器真实状态为准，不写死
        stats: { kbps: 0, ttfb: 0, failures: 0, lastProbe: 0, lastError: '' },
        rawStats: { ttfb: 0, failures: 0, lastProbe: 0, lastError: '' },
        score: 0,
      }]);
    });
    if (duplicate) return { ok: false, reason: 'duplicate' };
    // 用户重新添加了之前删掉的内置镜像 → 清掉墓碑，避免下次补齐逻辑再跳过它
    const h = MFL.hostOf(base);
    const t = await ext.storage.local.get(K.removedBuiltin);
    if (t[K.removedBuiltin] && t[K.removedBuiltin][h]) {
      const tombs = Object.assign({}, t[K.removedBuiltin]);
      delete tombs[h];
      await ext.storage.local.set({ [K.removedBuiltin]: tombs });
    }
    await applyRules();
    return { ok: true, state: await getState() };
  },

  'remove-mirror': async msg => {
    let removedHost = '';
    let removedSource = '';
    await mutateMirrors(list => {
      // 优先按 base 精确匹配（id 由 host 派生，a-b.com 与 a.b.com 会撞车）；否则按 id 只删第一条
      let idx = msg.base ? list.findIndex(m => MFL.normalizeBase(m.base) === MFL.normalizeBase(msg.base)) : -1;
      if (idx < 0) idx = list.findIndex(m => m.id === msg.id);
      if (idx < 0) return undefined;
      removedHost = MFL.hostOf(list[idx].base);
      removedSource = list[idx].source || '';
      return list.filter((_, i) => i !== idx);
    });
    // 顺手清掉这个 host 的缺失计时，避免 storage 里留无主记录
    if (removedHost) {
      const o = await ext.storage.local.get(K.listMissing);
      const miss = o[K.listMissing] || {};
      if (miss[removedHost]) { delete miss[removedHost]; await ext.storage.local.set({ [K.listMissing]: miss }); }
      // 内置镜像被手动删掉 → 记墓碑，升级/启动补齐时不要复活它
      if (removedSource === 'builtin') {
        const t = await ext.storage.local.get(K.removedBuiltin);
        const tombs = t[K.removedBuiltin] || {};
        tombs[removedHost] = Date.now();
        await ext.storage.local.set({ [K.removedBuiltin]: tombs });
      }
    }
    await applyRules();
    return { ok: true, state: await getState() };
  },

  'toggle-mirror': async msg => {
    await mutateMirrors(list => list.map(m => m.id === msg.id ? Object.assign({}, m, { enabled: !!msg.enabled }) : m));
    await applyRules();
    return { ok: true, state: await getState() };
  },

  // 'update-mirror' 已删除：1.4.7 之后没有调用方，而它正是「把 permitted 写死成 true」那条 bug 的入口。

  'probe-all': async () => probeAll('manual'),
  'probe-these': async msg => probeAll('manual', msg.ids || []),
  'probe-one': async msg => {
    const list = await getMirrors();
    const m = list.find(x => x.id === msg.id);
    if (!m) return { ok: false };
    const permitted = await hasPermission(m.base);
    if (!permitted) return { ok: false, reason: 'no-permission' };
    const r = await probeOne(m);
    const verdict = MFL.evaluateProbe(r);
    const raw = verdict.ok ? await probeRawOne(m) : null;
    const at = Date.now();
    await mutateMirrors(latest => latest.map(x => {
      if (x.id !== msg.id) return x;
      const fail = verdict.ok ? 0 : ((x.stats && x.stats.failures) || 0) + 1;
      return Object.assign({}, x, {
        healthy: fail < 3,
        rawStats: nextRawStats(x.rawStats, raw),
        stats: {
          kbps: verdict.ok ? Math.round(r.kbps) : 0,
          ttfb: verdict.ok ? Math.round(r.ttfb) : 0,
          failures: fail,
          lastProbe: at,
          lastError: verdict.ok ? '' : verdict.reason,
        },
      });
    }));
    await applyRules();
    return { ok: verdict.ok, verdict, state: await getState() };
  },

  'apply': async () => ({ ok: true, rules: await applyRules(true) }),
  'refresh-permissions': async () => { await refreshPermissions(); await applyRules(); return { ok: true, state: await getState() }; },
  'fetch-list': async () => runListFetch(),
  'sync-alarms': async () => { await syncAlarms(); return { ok: true }; },

  // raw 失败率统计：手动重测 / 清空样本 / 一键换镜像 / 导出诊断快照
  'raw-reprobe': async () => {
    await ext.storage.local.set({ [K.rawReprobeAt]: Date.now(), [K.rawSample]: [] });
    return Object.assign({ ok: true }, await probeRawAll('manual'));
  },
  'raw-sample-reset': async () => {
    await ext.storage.local.remove([K.rawSample, K.rawPending, K.rawUnknown]);
    return { ok: true, state: await getState() };
  },
  'switch-mirror': async () => switchMirror(),
  'diagnostic': async () => ({ ok: true, data: await buildDiagnostic() }),

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

/* ---------------------- 真实请求反馈（正式包也生效） ----------------------
 * MV3 里 webRequest 的**观察**事件仍可用（需要 webRequest 权限），但有一条实测硬约束：
 *   - 只给 raw.githubusercontent.com 权限时，被 DNR 改写到镜像域名的请求只有 onBeforeRequest，
 *     完成/错误事件根本不派发；
 *   - 对镜像域名也有 host 权限后，onCompleted 会以镜像 URL 派发、statusCode 可读。
 * 所以开启 raw 时会一并申请当前分片域名。没拿到的分片会留下「已发起但没结果」的 pending，
 * 超时后记为 unknown（不计入失败率分母），避免「观察不到」被误判成「失败」而反复重测。
 */
let rawChain = Promise.resolve();
function queueRaw(fn) {
  rawChain = rawChain.then(fn, fn).catch(() => {});
  return rawChain;
}

const isRawStart = u => /^https:\/\/raw\.githubusercontent\.com\//.test(String(u || ''));
const hasRawTrace = u => String(u || '').includes('raw.githubusercontent.com');

function expirePending(pending, now) {
  const live = (pending || []).filter(p => p && now - (p.t || 0) < RAW_PENDING_TTL_MS);
  return { live, expired: (pending || []).length - live.length };
}

/** 「无法观测」也按滑动窗口计数：否则长期运行会累加成天文数字，界面失去意义 */
function bumpUnknown(prev, add, now) {
  if (!add) return null;
  const p = typeof prev === 'number' ? { n: prev, at: now } : (prev || { n: 0, at: now });
  const base = (now - (p.at || 0) < RAW_SAMPLE_WINDOW_MS) ? (p.n || 0) : 0;
  return { n: base + add, at: now };
}

/** 结算一条 raw 请求：成功/失败写进滑动窗口，然后看是否该立刻重测分片 */
async function settleRaw(requestId, verdict) {
  const now = Date.now();
  const o = await ext.storage.local.get([K.rawSample, K.rawPending, K.rawUnknown, K.rawReprobeAt]);
  const { live, expired } = expirePending(o[K.rawPending], now);
  let idx = live.findIndex(p => p.id === requestId);
  if (idx < 0) idx = 0;                       // 镜像 URL 的 requestId 可能与原始请求不同 → 结算最老的一条
  if (!live.length) return;
  const hit = live[idx];
  live.splice(idx, 1);
  const unknownNext = bumpUnknown(o[K.rawUnknown], expired, now);
  const patch = { [K.rawPending]: live };
  if (unknownNext) patch[K.rawUnknown] = unknownNext;

  // 404/410 是「文件真的不存在」，不是镜像故障：不计成功也不计失败，直接丢弃
  if (verdict === 'ignore') {
    await ext.storage.local.set(patch);
    dbg('raw', '忽略 404/410（文件不存在，不算镜像故障）', { host: hit && hit.host });
    return;
  }

  const samples = MFL.pushRawSample(o[K.rawSample] || [], verdict === 'ok', now,
    { windowMs: RAW_SAMPLE_WINDOW_MS, max: RAW_PENDING_MAX });
  patch[K.rawSample] = samples;
  await ext.storage.local.set(patch);
  await maybeReprobe(samples, o[K.rawReprobeAt] || 0, unknownNext ? unknownNext.n : 0);
}

async function noteRawStart(requestId, url) {
  const now = Date.now();
  const o = await ext.storage.local.get(K.rawPending);
  const { live, expired } = expirePending(o[K.rawPending], now);
  let host = '';
  try { host = new URL(String(url || '')).host; } catch { /* 忽略 */ }
  live.push({ id: requestId, t: now, host });
  const patch = { [K.rawPending]: live.slice(-RAW_PENDING_MAX) };
  if (expired) {
    const u = await ext.storage.local.get(K.rawUnknown);
    const next = bumpUnknown(u[K.rawUnknown], expired, now);
    if (next) patch[K.rawUnknown] = next;
  }
  await ext.storage.local.set(patch);
}

/** 失败率达到阈值 → 立刻重测 raw 分片、重排 top5；冷却 + 清空样本防风暴 */
async function maybeReprobe(samples, lastAt, unknown) {
  const settings = await getSettings();
  const cfg = settings.raw || {};
  if (!cfg.enabled) return;
  const v = MFL.shouldReprobe(samples, {
    threshold: cfg.failureThreshold,
    minSamples: cfg.minSamples,
    cooldownMin: cfg.cooldownMin,
    lastAt,
  }, Date.now());
  dbg('raw', '失败率判定', { total: v.total, failures: v.failures, rate: v.rate + '%', reason: v.reason, unknown });
  if (!v.trigger) return;
  await ext.storage.local.set({ [K.rawReprobeAt]: Date.now(), [K.rawSample]: [] });
  dbg('raw', '失败率超阈值，立刻重测 raw 分片');
  await probeRawAll('failure-rate');
}

/**
 * webRequest 是 optional permission：默认根本不存在这个 API，只有用户在设置页点过「同时加速 raw」
 * 并同意授权后才出现。所以不能把 ext.webRequest 缓存成模块级常量，必须在授权后动态重取。
 */
let rawWatchersOn = false;
function ensureRawWatchers() {
  const WR = ext.webRequest;
  if (rawWatchersOn || !WR || !WR.onBeforeRequest || !WR.onCompleted || !WR.onErrorOccurred) return false;
  WR.onBeforeRequest.addListener(d => {
    if (!isRawStart(d.url)) return;
    queueRaw(async () => {
      const s = await getSettings();
      if (s.raw && s.raw.enabled) await noteRawStart(d.requestId, d.url);
    });
  }, { urls: ['https://raw.githubusercontent.com/*'], types: ['main_frame'] });

  WR.onCompleted.addListener(d => {
    if (!hasRawTrace(d.url)) return;
    queueRaw(async () => {
      const s = await getSettings();
      if (s.raw && s.raw.enabled) {
        await settleRaw(d.requestId, MFL.classifyRawStatus(d.statusCode));
      }
    });
  }, { urls: ['<all_urls>'], types: ['main_frame'] });

  WR.onErrorOccurred.addListener(d => {
    if (!hasRawTrace(d.url)) return;
    const err = String(d.error || '');
    // 用户主动取消/导航跳走不算镜像故障
    if (/ABORTED|USER_CANCELED/i.test(err)) return;
    queueRaw(async () => {
      const s = await getSettings();
      if (s.raw && s.raw.enabled) await settleRaw(d.requestId, 'fail');
    });
  }, { urls: ['<all_urls>'], types: ['main_frame'] });
  rawWatchersOn = true;
  dbg('raw', '已注册 webRequest 观察（可选权限已授予）');
  return true;
}
ensureRawWatchers();
if (ext.permissions && ext.permissions.onAdded) {
  ext.permissions.onAdded.addListener(() => { ensureRawWatchers(); });
}

/** 真实下载失败 → 给对应镜像记一次故障、自动换到下一个健康镜像 */
async function noteDownloadFailure(id, err) {
  let item;
  try {
    const arr = await ext.downloads.search({ id });
    item = arr && arr[0];
  } catch { return; }
  if (!item) return;
  const url = String(item.finalUrl || item.url || '');
  if (!/^https:\/\//.test(url)) return;   // 任务文件是 data:/blob:，不算
  const mirrors = await getMirrors();
  const hit = mirrors.find(m => {
    const h = MFL.hostOf(m.base);
    return h && (url.indexOf('https://' + h + '/') === 0);
  });
  if (!hit) return;
  const host = MFL.hostOf(hit.base);
  const now = Date.now();
  const o = await ext.storage.local.get(K.dlFailures);
  const all = o[K.dlFailures] || {};
  if (all[host] && now - all[host].lastAt < DL_FAILURE_COOLDOWN_MS) return;
  all[host] = { count: (all[host] && all[host].count || 0) + 1, lastAt: now };
  // 只保留最近 20 个 host，别让 storage 无限长
  const keep = Object.entries(all).sort((a, b) => b[1].lastAt - a[1].lastAt).slice(0, 20);
  await ext.storage.local.set({ [K.dlFailures]: Object.fromEntries(keep) });
  await mutateMirrors(list => list.map(m => {
    if (MFL.hostOf(m.base) !== host) return m;
    const failures = ((m.stats && m.stats.failures) || 0) + 1;
    return Object.assign({}, m, {
      healthy: failures < 3,
      stats: Object.assign({}, m.stats, {
        failures,
        lastError: '下载中断' + (err ? '（' + String(err).slice(0, 32) + '）' : ''),
      }),
    });
  }));
  await applyRules();
  dbg('download', '真实下载失败，已降权并换镜像', { host, count: all[host].count });
}

/** 手动「换镜像重试」：把当前 primary 记一次故障，让 chooseMirrors 选下一个 */
async function switchMirror() {
  const settings = await getSettings();
  const mirrors = await getMirrors();
  const ranked = mirrors.filter(m => m.enabled && m.healthy);
  // 只剩一个健康镜像时不要「换」——把它降权只会让规则变成 0 条，下载全部走主站
  if (ranked.length < 2) return { ok: false, reason: 'no-alternative' };
  const best = MFL.chooseMirrors(mirrors, settings).primary;
  if (!best) return { ok: false, reason: 'no-mirror' };
  await mutateMirrors(list => list.map(m => m.id === best.id
    ? Object.assign({}, m, {
      healthy: false,
      stats: Object.assign({}, m.stats, { failures: (m.stats.failures || 0) + 1, lastError: '手动换镜像' }),
    })
    : m));
  const rules = await applyRules();
  return { ok: true, from: best.name, to: rules.best && rules.best.name, rules };
}

/** 生产包没有日志，用户主动导出一份脱敏快照用于自查 */
async function buildDiagnostic() {
  const st = await getState();
  const s = st.settings || {};
  return {
    at: new Date().toISOString(),
    version: ext.runtime.getManifest().version,
    debug: !!ext.runtime.getManifest().debug,
    ua: (typeof navigator !== 'undefined' && navigator.userAgent) || '',
    settings: Object.assign({}, s, { token: s.token ? '***' : '' }),
    ruleInfo: st.ruleInfo,
    inWindow: st.inWindow,
    lastProbe: st.lastProbe,
    rawStats: st.rawStats,
    dlFailures: st.dlFailures,
    mirrors: (st.mirrors || []).map(m => ({
      name: m.name, base: m.base, source: m.source, enabled: m.enabled,
      permitted: m.permitted, healthy: m.healthy, score: m.score,
      note: m.note || '', seedKbps: m.seedKbps || 0,
      stats: m.stats || {}, rawStats: m.rawStats || {},
    })),
  };
}

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

// 真实下载失败的健康信号：正式包也注册（以前只在 debug 构建里挂），
// 用户主动取消 / 浏览器关机 / 页面跳走不算镜像故障。
if (ext.downloads && ext.downloads.onChanged) {
  ext.downloads.onChanged.addListener(delta => {
    if (!delta || !delta.state || delta.state.current !== 'interrupted') return;
    const err = String((delta.error && delta.error.current) || '');
    // 只认网络/服务端错误：USER_*、CRASHED、FILE_*（磁盘满/无权限）都不是镜像的错，
    // 用黑名单排除会漏掉 FILE_NO_SPACE 这类，把磁盘问题误算成镜像故障。
    if (!/^(NETWORK_|SERVER_)/.test(err)) return;
    noteDownloadFailure(delta.id, err).catch(() => {});
  });
}

/* --------------------------------- 生命周期 ------------------------------- */

/**
 * full=true 只在安装/浏览器启动时跑：灌内置镜像 + 全量权限扫描 + 强制重建规则。
 * SW 每次被唤醒走轻量路径：只核对闹钟与规则指纹，规则没变就不碰 DNR。
 */
async function bootstrap(full) {
  dbg('boot', '后台启动/唤醒', {
    version: ext.runtime.getManifest().version,
    debug: !!(ext.runtime.getManifest().debug),
    full: !!full,
  });
  const raw = await ext.storage.local.get(K.settings);
  const first = !raw[K.settings];
  if (first) {
    await ext.storage.local.set({ [K.settings]: JSON.parse(JSON.stringify(MFL.DEFAULT_SETTINGS)) });
  }
  if (full || first) {
    await seedMirrors();
    await refreshPermissions();
    await applyRules(true);
  } else {
    await applyRules(false);
  }
  await syncAlarms();
  // 浏览器启动时顺带检查一次远程清单是否过期（被 24h 闸门挡着，不会每次都拉）
  maybeRefreshList(false).catch(() => {});
}

ext.runtime.onInstalled.addListener(() => { bootstrap(true).catch(() => {}); });
ext.runtime.onStartup.addListener(() => { bootstrap(true).catch(() => {}); });
bootstrap(false).catch(() => {});
