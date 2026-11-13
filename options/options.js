/* 镜像快车道 - 设置页 */
'use strict';

const ext = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;
const $ = id => document.getElementById(id);

let state = null;

/* ------------------------------- i18n（折中方案） -------------------------------
 * 只把设置页的「状态 / 按钮 / 表头 / 关键提示」双语化，正文说明保持中文（成本 S）。
 * 字典走 _locales：中文浏览器读 zh_CN、其它读 en，浏览器自动选，不需要自己判断语言。
 * 动态文案用 t(key, 中文原文)，缺键时回退中文，永远不会显示 key 名。
 */
function t(key, fallback) {
  let v = '';
  try { v = ext.i18n.getMessage(key) || ''; } catch { /* 非扩展环境 */ }
  return v || fallback || key;
}

function isEn() {
  try { return !/^zh\b/i.test(ext.i18n.getUILanguage() || ''); } catch { return false; }
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const v = t(el.dataset.i18n, el.textContent.trim());
    if (v) el.textContent = v;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const v = t(el.dataset.i18nPlaceholder, el.placeholder);
    if (v) el.placeholder = v;
  });
}

// toast 调用点很多，用一张「中文 → 英文」表在出口统一翻译，避免逐个改调用
const TOAST_EN = {
  '未获得授权': 'Permission denied',
  '地址无效，需要是 https:// 开头的域名': 'Invalid address: needs an https:// host',
  '未获得该域名的访问授权，无法使用': 'Permission denied for this host',
  '该镜像已存在': 'This mirror already exists',
  '已添加，正在测速…': 'Added, probing…',
  '页面还没加载完，稍等一下再点': 'Still loading, try again in a moment',
  '清单地址必须是 https://': 'List URL must start with https://',
  '请先勾选「启用远程清单」': 'Enable the remote list first',
  '测速完成': 'Probing finished',
  '内置镜像都已授权': 'All built-in mirrors are authorized',
  '镜像都已授权': 'All mirrors are authorized',
  '远程镜像都已授权（以后清单新增的，需要再点一次）': 'All current remote mirrors are authorized (new ones need another click)',
  '没有可授权的地址': 'Nothing to authorize',
  '未获得 api.github.com 授权，取不到期望哈希': 'api.github.com permission denied; expected hash unavailable',
  '自动校验已开启，可以点下载链接测试了': 'Auto hash check is on — click a download link to test',
  '已授权，正在测速…': 'Authorized, probing…',
  '浏览器没有真正授予这个域名，请在「站点访问权限」里确认后重试':
    'The browser did not actually grant this host; check Site access and retry',
  '该镜像尚未授权，请先点「授权」': 'Authorize this mirror first',
  '已刷新日志': 'Log refreshed',
  '已清空日志': 'Log cleared',
  '已导出日志文件': 'Log exported',
  'raw 加速没有开启': 'Raw acceleration was not enabled',
  '已开启 raw 加速：按 raw 自身延迟选前 5 个镜像分片': 'Raw acceleration on: top 5 mirrors by raw latency',
  '已重建 0 条规则': 'Rebuilt 0 rules',
};

function toast(msg) {
  const el = $('toast');
  el.textContent = isEn() ? (TOAST_EN[msg] || msg) : msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2200);
}

const dbg = (area, msg, data) => { if (typeof DBG !== 'undefined') DBG.log(area, msg, data); };

function briefOpts(r) {
  if (!r || typeof r !== 'object') return { value: r };
  const out = {};
  for (const k of ['ok', 'reason', 'error', 'skipped', 'count', 'added', 'probed', 'via']) {
    if (r[k] !== undefined) out[k] = r[k];
  }
  if (r.rules && r.rules.count !== undefined) out.rules = r.rules.count;
  if (r.tried) out.tried = r.tried.length;
  return out;
}

async function send(type, extra) {
  // 只记参数摘要，不要把 token 之类的敏感值写进日志
  const safe = Object.assign({}, extra || {});
  delete safe.token;
  if (safe.patch) {
    const p = Object.assign({}, safe.patch);
    delete p.token;
    safe.patch = p;
  }
  dbg('ui', '点击 → ' + type, safe);
  try {
    const r = await ext.runtime.sendMessage(Object.assign({ type }, extra || {}));
    dbg('ui', '结果 → ' + type, briefOpts(r));
    // save-settings 返回的是 {settings}，以前被忽略，导致页面 state 一直是旧值
    if (r && r.settings && state) state.settings = r.settings;
    // 只记布尔值，绝不把 token 内容写进日志
    if (r && r.settings) {
      dbg('ui', '保存后的自动校验状态', {
        hash: r.settings.hash, hasToken: !!String(r.settings.token || '').trim(),
      });
    }
    if (r && r.state) { state = r.state; render(); }
    return r;
  } catch (e) {
    dbg('ui', '失败 → ' + type, String(e && e.message ? e.message : e));
    throw e;
  }
}

/* --------------------------------- 渲染 ---------------------------------- */

function statusText(m) {
  if (!m.enabled) return t('stDisabled', '已停用');
  if (!m.permitted) return t('stNeedPerm', '需授权');
  if (!m.healthy) return t('stUnavailable', '不可用');
  if (!m.stats || !m.stats.lastProbe) return t('stUnmeasured', '未测速');
  return t('stAvailable', '可用');
}

function statusClass(m) {
  if (!m.enabled) return 'tag';
  if (!m.permitted) return 'tag warn';
  if (!m.healthy) return 'tag err';
  if (!m.stats || !m.stats.lastProbe) return 'tag';
  return 'tag ok';
}

function sourceLabel(s) {
  return s === 'builtin' ? t('srcBuiltin', '内置')
    : s === 'remote' ? t('srcRemote', '远程') : t('srcManual', '手动');
}

function renderMirrors() {
  const body = $('mirrorBody');
  body.textContent = '';

  if (!state.mirrors.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.style.color = 'var(--muted)';
    td.textContent = '没有镜像';
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  for (const m of state.mirrors) {
    const tr = document.createElement('tr');

    // 启用
    const tdOn = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.act = 'toggle';
    cb.dataset.id = m.id;
    cb.checked = !!m.enabled;
    tdOn.appendChild(cb);
    tr.appendChild(tdOn);

    // 名称 / 地址 / 错误
    const tdName = document.createElement('td');
    const nameDiv = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = m.name;
    nameDiv.appendChild(b);
    tdName.appendChild(nameDiv);

    const hostDiv = document.createElement('div');
    hostDiv.style.color = 'var(--muted)';
    hostDiv.style.fontSize = '11.5px';
    hostDiv.textContent = MFL.hostOf(m.base);
    tdName.appendChild(hostDiv);

    // note 与 seedKbps 以前只存在数据里、界面从不显示（比如「IDM 建议 4 连接」这种限流提示）
    if (m.note) {
      const noteDiv = document.createElement('div');
      noteDiv.style.cssText = 'color:var(--muted);font-size:11px;margin-top:2px';
      noteDiv.textContent = m.note;
      tdName.appendChild(noteDiv);
    }

    if (m.stats && m.stats.lastError) {
      const errDiv = document.createElement('div');
      errDiv.style.color = '#cf222e';
      errDiv.style.fontSize = '11px';
      errDiv.textContent = m.stats.lastError;
      tdName.appendChild(errDiv);
    }
    tr.appendChild(tdName);

    // 来源
    const tdSrc = document.createElement('td');
    const srcTag = document.createElement('span');
    srcTag.className = 'tag';
    srcTag.textContent = sourceLabel(m.source);
    tdSrc.appendChild(srcTag);
    tr.appendChild(tdSrc);

    // 状态
    const tdStatus = document.createElement('td');
    const st = document.createElement('span');
    st.className = statusClass(m);
    st.textContent = statusText(m);
    tdStatus.appendChild(st);
    tr.appendChild(tdStatus);

    // 速度 / 延迟：没测过时把清单里的参考带宽显示出来，别让「—」看起来像坏了
    const tdSpeed = document.createElement('td');
    tdSpeed.textContent = m.stats && m.stats.kbps ? MFL.formatKbps(m.stats.kbps)
      : (m.seedKbps ? '≈ ' + MFL.formatKbps(m.seedKbps) : '—');
    tr.appendChild(tdSpeed);

    const tdTtfb = document.createElement('td');
    tdTtfb.textContent = m.stats && m.stats.ttfb ? MFL.formatMs(m.stats.ttfb) : '—';
    tr.appendChild(tdTtfb);

    // 操作
    const tdAct = document.createElement('td');
    if (!m.permitted) tdAct.appendChild(mkBtn(t('btnGrant', '授权'), 'grant', m.id, ''));
    tdAct.appendChild(mkBtn(t('btnProbe', '测速'), 'probe', m.id, ''));
    tdAct.appendChild(mkBtn(t('btnRemove', '删除'), 'remove', m.id, 'danger'));
    tr.appendChild(tdAct);

    body.appendChild(tr);
  }
}

function mkBtn(text, act, id, cls) {
  const b = document.createElement('button');
  b.textContent = text;
  b.dataset.act = act;
  b.dataset.id = id;
  if (cls) b.className = cls;
  return b;
}

function render() {
  if (!state) return;
  const s = state.settings;
  $('enabled').checked = !!s.enabled;
  $('markLinks').checked = !!s.markLinks;
  $('clickToast').checked = !!s.clickToast;
  $('codeload').checked = !!(s.codeload && s.codeload.enabled);
  $('codeloadProbe').checked = !!(s.codeload && s.codeload.probeOn);
  $('splitMirrors').checked = !!(s.split && s.split.enabled);
  $('rawEnabled').checked = !!(s.raw && s.raw.enabled);
  $('rawEnabled2').checked = !!(s.raw && s.raw.enabled);   // 统计卡片里的同一个开关
  $('probeMode').value = s.probeMode || 'ondemand';
  $('probeInterval').value = s.probeIntervalMin || 60;
  $('winEnabled').checked = !!(s.activeWindow && s.activeWindow.enabled);
  $('winStart').value = (s.activeWindow && s.activeWindow.start) || '20:00';
  $('winEnd').value = (s.activeWindow && s.activeWindow.end) || '02:00';
  $('remoteEnabled').checked = !!(s.remoteList && s.remoteList.enabled);
  // 留空就显示内置默认地址，用户不改也能直接用
  $('remoteUrl').value = (s.remoteList && s.remoteList.url) || MFL.DEFAULT_SETTINGS.remoteList.url;
  $('remoteAllowDelete').checked = !(s.remoteList && s.remoteList.allowDelete === false);
  $('hashEnabled').checked = !!(s.hash && s.hash.enabled);
  $('hashAuto').checked = !!(s.hash && s.hash.auto);
  $('token').value = s.token || '';

  const ri = state.ruleInfo || {};
  $('ruleTag').textContent = !state.inWindow ? t('tagOutOfWindow', '时段外')
    : (ri.count ? t('tagActive', '生效中') : t('tagNoMirror', '无可用'));
  $('ruleTag').className = 'tag ' + (!state.inWindow ? 'warn' : ri.count ? 'ok' : 'err');

  // 规则重建失败以前完全无声：徽章和 ruleInfo 都停在旧值，界面还显示「生效中」
  const errBox = $('ruleError');
  if (ri.error) {
    errBox.textContent = '规则重建失败 / Rule rebuild failed：' + ri.error;
    errBox.style.display = '';
  } else {
    errBox.style.display = 'none';
  }

  let routeText = '';
  if (ri.best) {
    routeText = '直链走 ' + ri.best.name;
    if (ri.archive && ri.archive.host !== ri.best.host) routeText += '，源码包走 ' + ri.archive.name;
    if (ri.raw && ri.raw.length) {
      const hosts = Array.from(new Set(ri.raw.map(x => x.host)));
      routeText += '，raw 分 ' + hosts.length + ' 个镜像';
    }
  } else {
    routeText = '当前无镜像，下载走主站';
  }
  $('ruleInfo').textContent = '规则 ' + (ri.count || 0) + ' 条；' + routeText;

  const lf = state.listFetched;
  $('remoteInfo').textContent = lf
    ? (lf.ok
      ? MFL.relativeTime(lf.at) + '，经 ' + (lf.via || '直连') + '，新增 ' + (lf.added || 0) + ' 个'
        + (lf.removed ? '，移除 ' + lf.removed + ' 个' : '')
      : MFL.relativeTime(lf.at) + '，全部失败')
    : '从未';

  $('diag').textContent = '探测模式 ' + (s.probeMode === 'interval' ? '定时/' + s.probeIntervalMin + ' 分钟' : '仅按需') +
    '；上次测速 ' + MFL.relativeTime(state.lastProbe);

  // raw 失败率统计：样本 / 失败率 / 观测不到的次数 / 上次自动重测
  const rawCfg = s.raw || {};
  $('rawThreshold').value = Number.isFinite(rawCfg.failureThreshold) ? rawCfg.failureThreshold : 30;
  $('rawMinSamples').value = rawCfg.minSamples || 5;
  $('rawCooldown').value = rawCfg.cooldownMin || 5;
  const rs = state.rawStats || { samples: [], unknown: 0, lastReprobeAt: 0 };
  const samples = rs.samples || [];
  const fails = samples.filter(x => !x.ok).length;
  const rate = samples.length ? Math.round(fails / samples.length * 100) : 0;
  $('rawStatsInfo').textContent = (isEn()
    ? 'Observed ' + samples.length + ', failed ' + fails + ' (' + rate + '%), unobservable ' + (rs.unknown || 0) +
      '; last auto re-probe ' + MFL.relativeTime(rs.lastReprobeAt)
    : '最近 ' + samples.length + ' 次，失败 ' + fails + '（' + rate + '%），无法观测 ' + (rs.unknown || 0) +
      '；上次自动重测 ' + MFL.relativeTime(rs.lastReprobeAt))
    + (rawCfg.enabled ? '' : (isEn() ? ' · raw off' : ' · raw 未开启'));

  const dl = state.dlFailures || {};
  const dlHosts = Object.keys(dl);
  const dlTotal = dlHosts.reduce((n, k) => n + (dl[k].count || 0), 0);
  $('dlFailInfo').textContent = dlHosts.length
    ? (isEn() ? dlTotal + ' failures on ' + dlHosts.length + ' hosts'
      : dlTotal + ' 次，涉及 ' + dlHosts.length + ' 个镜像')
    : (isEn() ? 'None' : '无');

  renderMirrors();

  // 两个批量授权按钮上直接标「还差几个没授权」，避免点了没反应以为已经全授权
  const mirrors = state.mirrors || [];
  const pendingBuiltin = mirrors.filter(m => m.source === 'builtin' && !m.permitted).length;
  const pendingRemote = mirrors.filter(m => m.source === 'remote' && !m.permitted).length;
  $('grantAll').textContent = t('btnGrantBuiltin', '一键授权内置镜像') + (pendingBuiltin ? '（' + pendingBuiltin + '）' : '');
  $('grantRemote').textContent = t('btnGrantRemote', '授权远程镜像') + (pendingRemote ? '（' + pendingRemote + '）' : '');

  $('probeInterval').disabled = s.probeMode !== 'interval';
  updateHashStatus();     // 异步刷新，不阻塞界面渲染
  checkPermsOnRender();   // 「已开启但权限被撤销/拒绝」时给出可操作指引
}

/* --------------------------------- 事件 ---------------------------------- */

async function refresh() {
  state = await ext.runtime.sendMessage({ type: 'get-state' });
  render();
}

$('mirrorBody').addEventListener('click', async ev => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;

  if (act === 'probe') {
    btn.disabled = true; btn.textContent = '…';
    const r = await send('probe-one', { id });
    if (r && r.reason === 'no-permission') toast('该镜像尚未授权，请先点「授权」');
    else if (r && r.verdict && !r.verdict.ok) toast('不可用：' + r.verdict.reason);
    btn.disabled = false; btn.textContent = t('btnProbe', '测速');
    return;
  }

  if (act === 'remove') {
    const m = state.mirrors.find(x => x.id === id);
    if (!m || !confirm('删除镜像 ' + m.name + '？')) return;
    await send('remove-mirror', { id, base: m.base });
    return;
  }

  if (act === 'grant') {
    const m = state.mirrors.find(x => x.id === id);
    if (!m) return;
    const ok = await requestOrigin(m.base);
    if (ok) {
      // 以浏览器真实状态回填（以前直接写 permitted=true，会出现「显示已授权但测不了」）
      const r = await send('refresh-permissions');
      const cur = r && r.state ? (r.state.mirrors || []).find(x => x.id === id) : null;
      if (cur && !cur.permitted) {
        return toast('浏览器没有真正授予这个域名，请在「站点访问权限」里确认后重试');
      }
      toast('已授权，正在测速…');
      await send('probe-one', { id });
    } else {
      toast('未获得授权');
    }
  }
});

$('mirrorBody').addEventListener('change', async ev => {
  const cb = ev.target.closest('input[data-act="toggle"]');
  if (!cb) return;
  await send('toggle-mirror', { id: cb.dataset.id, enabled: cb.checked });
});

async function requestOrigin(base) {
  const pattern = MFL.originPattern(base);
  if (!pattern) return false;
  let ok = false;
  try { ok = await ext.permissions.request({ origins: [pattern] }); }
  catch (e) { dbg('perm', '镜像域名授权异常', String(e && e.message ? e.message : e)); }
  dbg('perm', '镜像域名授权', { pattern, granted: ok });
  return ok;
}

/** 哈希功能要用 api.github.com；没这一步权限，任务文件里的 expected 永远是 null */
async function ensureApiPermission() {
  const origins = ['https://api.github.com/*'];
  let result = false;
  try {
    // 不要先 contains 再 request：Firefox 只要在 request 之前 await 过任何东西，
    // 用户手势就丢了，request 会被直接拒绝（表现为「点了没反应/未获得授权」）。
    // 已授予时 request 会立即返回 true 且不弹窗，所以省掉预检没有副作用。
    result = await ext.permissions.request({ origins });
  } catch (e) {
    dbg('perm', 'api.github.com 授权异常', String(e && e.message ? e.message : e));
  }
  dbg('perm', 'api.github.com 权限', { granted: result, origins });
  return result;
}

async function toggleHashFlag(flag, el) {
  dbg('ui', '切换哈希开关 → ' + flag, { checked: el.checked });

  // 必须放在任何 await 之前：Firefox 的 permissions.request 只认「当前用户手势」，
  // 先 await 读一次 state 手势就丢了 —— 表现就是弹窗不出现、开关自己弹回去。
  if (el.checked && !(await ensureApiPermission())) {
    el.checked = false;
    showPermHelp();
    return toast('未获得 api.github.com 授权，取不到期望哈希');
  }

  // 以后台的最新设置为基准。以前用页面里过期的 state 拼 patch，
  // 连续勾「启用」+「自动」时，第二次会把第一次的 enabled 覆盖成 false。
  let cur = { enabled: false, auto: false };
  try {
    const s = await ext.runtime.sendMessage({ type: 'get-state' });
    if (s && s.settings && s.settings.hash) {
      cur = Object.assign({}, cur, s.settings.hash);
      state = s;
    }
  } catch { /* 拿不到就用页面上的值 */ }

  const hash = Object.assign({}, cur, { [flag]: el.checked });
  dbg('ui', '哈希开关合并后的完整值', hash);
  await send('save-settings', { patch: { hash } });
  if (state && state.settings) state.settings.hash = hash;
  if (flag === 'auto' && el.checked && !hash.enabled) {
    toast('还要打开上面的「启用哈希校验」');
  }
}

$('hashEnabled').addEventListener('change', e => toggleHashFlag('enabled', e.target));
$('hashAuto').addEventListener('change', e => toggleHashFlag('auto', e.target));

/* --------------------------- 自动校验状态 --------------------------- */
// 解包扩展重新加载（尤其删掉重装）会清空 storage，用户常以为开关还开着。
// 把「两个开关 + API 权限 + token」的齐全程度直接摆出来，不用再靠日志猜。
async function updateHashStatus() {
  if (!state || !$('hashStatusHint')) return;
  const s = state.settings || {};
  const h = s.hash || {};
  let permitted = false;
  try { permitted = await ext.permissions.contains({ origins: ['https://api.github.com/*'] }); } catch {}
  const missing = [];
  if (!h.enabled) missing.push('「启用哈希校验」未勾选');
  if (!h.auto) missing.push('「下载时写校验任务」未勾选');
  if (!permitted) missing.push('缺少 api.github.com 授权');
  const ready = missing.length === 0;
  const hasToken = !!String(s.token || '').trim();
  $('hashStatusTag').textContent = ready ? t('hashReady', '已就绪') : t('hashNotReady', '未就绪');
  $('hashStatusTag').className = 'tag ' + (ready ? 'ok' : 'err');
  $('hashStatusHint').textContent = ready
    ? '点击 GitHub 下载链接会自动写任务文件；' + (hasToken ? 'Token 已配置' : '未填 Token（匿名 60 次/小时，够测试）')
    : '还差：' + missing.join('、');
}

$('enableAutoHash').addEventListener('click', async () => {
  dbg('ui', '点击 → 一键开启自动校验');
  // permissions.request 必须在用户手势的调用栈里发起，所以先申请再保存
  if (!(await ensureApiPermission())) {
    showPermHelp();
    return toast('未获得 api.github.com 授权，取不到期望哈希');
  }
  const token = $('token').value.trim();
  const patch = { hash: { enabled: true, auto: true } };
  if (token) patch.token = token;
  await send('save-settings', { patch });
  render();
  await updateHashStatus();
  toast('自动校验已开启，可以点下载链接测试了');
});

$('addBtn').addEventListener('click', async () => {
  const base = MFL.normalizeBase($('newBase').value);
  if (!base) return toast('地址无效，需要是 https:// 开头的域名');
  const ok = await requestOrigin(base);
  if (!ok) return toast('未获得该域名的访问授权，无法使用');
  const r = await send('add-mirror', { name: $('newName').value.trim(), base, permitted: true });
  if (r && r.ok === false) return toast(r.reason === 'duplicate' ? '该镜像已存在' : '添加失败：' + r.reason);
  $('newBase').value = ''; $('newName').value = '';
  toast('已添加，正在测速…');
  const m = (state.mirrors || []).find(x => MFL.hostOf(x.base) === MFL.hostOf(base));
  if (m) await send('probe-one', { id: m.id });
});

function bindToggle(id, patchFn) {
  $(id).addEventListener('change', async e => {
    await send('save-settings', { patch: patchFn(e.target) });
  });
}

bindToggle('enabled', el => ({ enabled: el.checked }));
bindToggle('markLinks', el => ({ markLinks: el.checked }));
bindToggle('clickToast', el => ({ clickToast: el.checked }));
bindToggle('codeload', el => ({ codeload: Object.assign({}, state.settings.codeload, { enabled: el.checked }) }));
bindToggle('codeloadProbe', el => ({ codeload: Object.assign({}, state.settings.codeload, { probeOn: el.checked }) }));
bindToggle('splitMirrors', el => ({ split: Object.assign({}, state.settings.split, { enabled: el.checked }) }));
// raw 需要 raw.githubusercontent.com 的 host 权限（Chrome 要求被改写的请求有权限才会应用 redirect），
// 所以不能走 bindToggle：必须在勾选这个手势里先申请权限，没拿到就把开关退回去
/** 当前 raw 分片用到的镜像域名。首次开启时规则里还没有分片，就用健康镜像里排最前的几个 */
function rawShardOrigins() {
  const ri = state && state.ruleInfo;
  const shards = (ri && ri.raw) || [];
  const fromRules = shards.map(x => x.host && 'https://' + x.host + '/*').filter(Boolean);
  if (fromRules.length) return fromRules;
  return (state.mirrors || []).filter(m => m.enabled && m.healthy)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, MFL.RAW_REGEXES.length)
    .map(m => MFL.originPattern(m.base)).filter(Boolean);
}

/**
 * 开启 raw 要一并申请：被改写的 raw host + 能看到「改写后结果」的镜像域名 +
 * 可选 API 权限 webRequest（默认零权限，实测未授予时 chrome.webRequest 不存在）。
 * 缺镜像域名权限时，请求只有「发起」没有「结果」，统计会算不出失败率。
 */
/** Firefox 有 runtime.getBrowserInfo，Chromium 没有 */
function isFirefoxBrowser() {
  try { return !!(ext.runtime && ext.runtime.getBrowserInfo); } catch { return false; }
}

async function requestRawBundle(originsOnly) {
  const origins = Array.from(new Set(originsOnly || ['https://raw.githubusercontent.com/*'].concat(rawShardOrigins())));
  // 关键：request 之前不能有任何 await。Firefox 只认「当前用户手势」，
  // 先 await 一次 permissions.contains 就会丢手势，弹窗不出现、开关自己弹回。
  // Firefox 上也不申请 webRequest（可选 API 权限的运行时申请不可靠）：
  // raw 加速只依赖 host 权限，统计在 Firefox 上降级为「无法观测」，不影响加速。
  const req = { origins };
  if (!isFirefoxBrowser()) req.permissions = ['webRequest'];
  try {
    return { ok: await ext.permissions.request(req), origins };
  } catch {
    // Chromium 上若整体申请被拒（例如 webRequest 不可选），退回只申请 host 权限
    try { return { ok: await ext.permissions.request({ origins }), origins }; }
    catch { return { ok: false, origins }; }
  }
}

/** 两个 raw 开关（改写行为 / 统计卡片）共用这一个处理函数 */
async function handleRawToggle(el) {
  if (el.checked) {
    const r = await requestRawBundle();
    if (!r.ok) {
      el.checked = false;
      $('rawEnabled').checked = false;
      $('rawEnabled2').checked = false;
      showPermHelp();
      return toast('未获得 raw 相关授权，raw 加速没有开启');
    }
    let wrOk = false;
    try { wrOk = await ext.permissions.contains({ permissions: ['webRequest'] }); } catch {}
    if (!wrOk) {
      toast(isEn() ? 'Raw is on, but failure-rate stats are unavailable on this browser'
        : '已开启 raw 加速，但此浏览器不支持失败率统计');
    }
  }
  await send('save-settings', { patch: { raw: Object.assign({}, state.settings.raw, { enabled: el.checked }) } });
  await send('apply');
  $('rawEnabled').checked = !!el.checked;
  $('rawEnabled2').checked = !!el.checked;
  if (el.checked) { hidePermHelp(); toast('已开启 raw 加速：按 raw 自身延迟选前 5 个镜像分片'); }
}
$('rawEnabled').addEventListener('change', e => handleRawToggle(e.target));
$('rawEnabled2').addEventListener('change', e => handleRawToggle(e.target));

/* ----------------------------- 权限帮助（关键提示） -----------------------------
 * Firefox 会记住「拒绝」，之后 permissions.request 直接返回 false、不再弹窗；
 * 用户只看到「未获得授权」是没法自救的，这里把下一步直接写出来。
 */
function permHelpTarget() {
  return isFirefoxBrowser() ? 'about:addons' : 'edge://extensions';
}

function showPermHelp(extra) {
  const text = isEn()
    ? (isFirefoxBrowser()
      ? 'Firefox remembers a denied permission and will not ask again. Open about:addons → Mirror Fastlane → Permissions → enable site access, then click Authorize again.'
      : 'The browser did not grant the permission. Open the extension details → Site access → Allow, then retry.')
    : (isFirefoxBrowser()
      ? 'Firefox 会记住「拒绝」，之后不会再弹窗。请打开 about:addons → 镜像快车道 → 权限 → 打开「访问网站」，再回来点一次授权。'
      : '浏览器没有真正授予权限。请打开扩展详情页 → 站点访问权限 → 允许，再回来重试。');
  $('permHelpText').textContent = (extra ? extra + ' ' : '') + text;
  $('permHelp').style.display = '';
}

function hidePermHelp() {
  $('permHelp').style.display = 'none';
}

$('permHelpClose').addEventListener('click', hidePermHelp);
$('permHelpCopy').addEventListener('click', async () => {
  const target = permHelpTarget();
  try { await navigator.clipboard.writeText(target); toast('已复制：' + target); }
  catch { toast(target); }
});

/** 已开启某个功能、但浏览器权限被撤销/拒绝时，主动把指引摆出来 */
async function checkPermsOnRender() {
  if (!state) return;
  const s = state.settings || {};
  let missing = false;
  if (s.raw && s.raw.enabled) {
    try { missing = !(await ext.permissions.contains({ origins: ['https://raw.githubusercontent.com/*'] })); } catch { /* ignore */ }
  }
  if (!missing && s.hash && s.hash.enabled) {
    try { missing = !(await ext.permissions.contains({ origins: ['https://api.github.com/*'] })); } catch { /* ignore */ }
  }
  if (missing) showPermHelp(); else hidePermHelp();
}

/* --------------------------------- 一键自检 --------------------------------- */

$('selfCheck').addEventListener('click', async () => {
  const btn = $('selfCheck');
  btn.disabled = true;
  btn.textContent = '检查中…';
  const r = await send('self-check');
  btn.disabled = false;
  btn.textContent = t('btnSelfCheck', '运行自检');
  const out = $('selfCheckOut');
  out.style.display = '';
  if (!r || !r.check) { out.textContent = '自检失败：' + ((r && r.error) || '未知'); return; }
  out.textContent = r.check.text;
  const bad = (r.check.items || []).filter(i => i.level === 'fail').length;
  toast(bad ? '发现 ' + bad + ' 个需要处理的问题' : '自检通过');
});

$('selfCheckCopy').addEventListener('click', async () => {
  const text = $('selfCheckOut').textContent || '';
  if (!text || text === '—') return toast('先运行一次自检');
  try { await navigator.clipboard.writeText(text); toast('已复制自检结果'); }
  catch {
    const r = document.createRange();
    r.selectNodeContents($('selfCheckOut'));
    const sel = getSelection();
    sel.removeAllRanges(); sel.addRange(r);
    toast('已选中，按 Ctrl+C 复制');
  }
});

/* --------------------------- raw 统计与诊断 UI --------------------------- */

$('rawReprobe').addEventListener('click', async () => {
  const r = await send('raw-reprobe');
  toast(isEn() ? 'Re-probed ' + (r.probed || 0) + ' raw mirrors'
    : '已重测 ' + (r.probed || 0) + ' 个 raw 镜像');
  await refresh();
});

$('rawShards').addEventListener('click', async () => {
  // 分片换了新的镜像时补一次授权，让统计重新看得到结果
  if (!state || !state.settings || !state.settings.raw || !state.settings.raw.enabled) {
    return toast(isEn() ? 'Turn on raw acceleration first' : '先开启 raw 加速，再补授权分片');
  }
  const origins = rawShardOrigins();
  if (!origins.length) return toast(isEn() ? 'No raw shards to authorize' : '当前没有 raw 分片');
  const r = await requestRawBundle(origins);
  toast(r.ok ? (isEn() ? 'Raw shards authorized' : 'raw 分片已补授权')
    : (isEn() ? 'Permission denied' : '未获得授权'));
  await refresh();
});

$('rawReset').addEventListener('click', async () => {
  await send('raw-sample-reset');
  toast(isEn() ? 'Samples cleared' : '样本已清空');
  await refresh();
});

['rawThreshold', 'rawMinSamples', 'rawCooldown'].forEach(id => {
  $(id).addEventListener('change', async e => {
    const v = Math.max(1, parseInt(e.target.value, 10) || 0);
    const key = id === 'rawThreshold' ? 'failureThreshold' : id === 'rawMinSamples' ? 'minSamples' : 'cooldownMin';
    await send('save-settings', { patch: { raw: Object.assign({}, state.settings.raw, { [key]: v }) } });
  });
});

$('diagExport').addEventListener('click', async () => {
  const r = await send('diagnostic');
  if (!r || !r.data) return toast(isEn() ? 'Diagnostic export failed' : '诊断快照导出失败');
  const text = JSON.stringify(r.data, null, 2);
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'mfl-diagnostic-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  toast(isEn() ? 'Diagnostic snapshot exported' : '已导出诊断快照（不含 Token）');
});
// 哈希两个开关在 toggleHashFlag 里单独处理：要先拿到 api.github.com 的权限

$('probeMode').addEventListener('change', async e => {
  await send('save-settings', { patch: { probeMode: e.target.value } });
});

$('probeInterval').addEventListener('change', async e => {
  const v = Math.max(15, Math.min(1440, parseInt(e.target.value, 10) || 60));
  await send('save-settings', { patch: { probeIntervalMin: v } });
});

['winEnabled', 'winStart', 'winEnd'].forEach(id => {
  $(id).addEventListener('change', async () => {
    await send('save-settings', {
      patch: {
        activeWindow: {
          enabled: $('winEnabled').checked,
          start: $('winStart').value || '20:00',
          end: $('winEnd').value || '02:00',
        },
      },
    });
  });
});

$('remoteEnabled').addEventListener('change', async e => {
  const cur = Object.assign({}, state.settings.remoteList);
  cur.enabled = e.target.checked;
  if (e.target.checked && cur.allowDelete === undefined) cur.allowDelete = true;   // 首次启用默认开
  await send('save-settings', { patch: { remoteList: cur } });
});

$('remoteAllowDelete').addEventListener('change', async e => {
  await send('save-settings', { patch: { remoteList: Object.assign({}, state.settings.remoteList, { allowDelete: e.target.checked }) } });
});

$('remoteUrl').addEventListener('change', async e => {
  const url = e.target.value.trim();
  if (url && !/^https:\/\//i.test(url)) return toast('清单地址必须是 https://');
  await send('save-settings', { patch: { remoteList: Object.assign({}, state.settings.remoteList, { url }) } });
});

$('fetchList').addEventListener('click', async () => {
  if (!state) return toast('页面还没加载完，稍等一下再点');
  // 先把输入框里的内容落盘：用户常常输入完直接点按钮，input 的 change 还没触发，
  // 后台读到的还是旧值（甚至空地址），就会报「未启用 / 地址为空」。
  // 输入框留空 = 用内置默认地址，不要在这里拦下；后台也是这么兜底的
  const url = $('remoteUrl').value.trim() || MFL.DEFAULT_SETTINGS.remoteList.url;
  if (!/^https:\/\//i.test(url)) return toast('清单地址必须是 https://');
  const enabled = $('remoteEnabled').checked;
  if (!enabled) return toast('请先勾选「启用远程清单」');

  await send('save-settings', {
    patch: { remoteList: Object.assign({}, state.settings.remoteList, { enabled, url }) },
  });

  $('fetchList').disabled = true;
  const r = await send('fetch-list');
  $('fetchList').disabled = false;

  const REASON = {
    'not-enabled': '未启用远程清单',
    'no-url': '清单地址为空',
    'all-failed': '所有来源都失败',
    disabled: '未启用远程清单',
    'bad-shape': '清单格式无法识别（应为 {"mirrors":[{"name":"x","base":"https://x"}]}）',
  };
  if (r && r.ok) {
    toast('已通过 ' + r.via + ' 获取，新增 ' + (r.added || 0) + ' 个' + (r.removed ? '，移除 ' + r.removed + ' 个' : ''));
  } else {
    let msg = REASON[r && r.reason] || (r && r.reason) || '未知';
    if (r && Array.isArray(r.tried) && r.tried.length) {
      msg += '：' + r.tried.slice(0, 3).map(t => t.via + ' ' + t.err).join('，');
    }
    toast('获取失败：' + msg);
  }
  refresh();
});

$('token').addEventListener('change', async e => {
  await send('save-settings', { patch: { token: e.target.value.trim() } });
});

$('probeNow').addEventListener('click', async () => {
  $('probeNow').disabled = true; $('probeNow').textContent = '测速中…';
  await send('probe-all');
  $('probeNow').disabled = false; $('probeNow').textContent = t('btnProbeNow', '立即测速全部');
  toast('测速完成');
});

/** 批量授权一批镜像。注意：permissions.request 必须在点击事件的调用栈里发起 */
async function grantMany(targets, label) {
  const origins = targets.map(m => MFL.originPattern(m.base)).filter(Boolean);
  if (!origins.length) { toast('没有可授权的地址'); return false; }
  let granted = false;
  try {
    granted = await ext.permissions.request({ origins });
  } catch (e) {
    toast('授权失败：' + (e && e.message ? e.message : e));
    return false;
  }
  if (!granted) { toast('未获得授权'); return false; }

  // 以浏览器的真实状态回填 permitted（比直接写 true 可靠），再只测这一批
  const r = await send('refresh-permissions');
  const ids = new Set(targets.map(m => m.id));
  const still = ((r && r.state && r.state.mirrors) || []).filter(m => ids.has(m.id) && !m.permitted);
  if (still.length) {
    toast('还有 ' + still.length + ' 个域名浏览器未真正授予，请在「站点访问权限」里确认');
  } else {
    toast(label + '：已申请 ' + origins.length + ' 个域名，正在测速…');
  }
  await send('probe-these', { ids: targets.map(m => m.id) });
  await refresh();
  return true;
}

$('grantAll').addEventListener('click', async () => {
  dbg('ui', '点击 → 一键授权内置镜像');
  const targets = (state.mirrors || []).filter(m => m.source === 'builtin' && !m.permitted);
  if (!targets.length) {
    const remotePending = (state.mirrors || []).filter(m => m.source === 'remote' && !m.permitted).length;
    return toast(remotePending
      ? '内置镜像都已授权；还有 ' + remotePending + ' 个远程镜像没授权，用下面的「授权远程镜像」'
      : '镜像都已授权');
  }
  await grantMany(targets, '内置镜像');
});

$('grantRemote').addEventListener('click', async () => {
  dbg('ui', '点击 → 授权远程镜像');
  // 只取「此刻已经在本地列表里」的远程镜像。之后清单自动新增的不在本次请求里，
  // 也就不会被授权——浏览器只允许在用户点击的当下申请权限，这正是想要的行为。
  const targets = (state.mirrors || []).filter(m => m.source === 'remote' && !m.permitted);
  if (!targets.length) return toast('远程镜像都已授权（以后清单新增的，需要再点一次）');
  await grantMany(targets, '远程镜像');
});

$('reapply').addEventListener('click', async () => {
  const r = await send('apply');
  toast('已重建 ' + ((r && r.rules && r.rules.count) || 0) + ' 条规则');
});

$('openVerify').addEventListener('click', () => {
  dbg('ui', '点击 → 打开校验页');
  ext.tabs.create({ url: ext.runtime.getURL('verify/verify.html') });
});

/* ------------------------------ 调试日志面板 ------------------------------ */
// 只在 debug 构建（manifest 里 debug:true）出现，正式包整块不渲染

function fmtLog(list) {
  if (!list.length) return '（暂无）';
  return list.map(DBG.formatLine).join('\n');
}

async function renderDebug() {
  if (typeof DBG === 'undefined' || !DBG.enabled) return;
  $('debugBox').style.display = '';
  const list = await DBG.dump();
  const box = $('dbgLog');
  box.textContent = fmtLog(list);
  box.scrollTop = box.scrollHeight;
}

if (typeof DBG !== 'undefined' && DBG.enabled) {
  $('dbgReload').addEventListener('click', () => { dbg('ui', '点击 → 刷新日志'); renderDebug(); toast('已刷新日志'); });
  $('dbgClear').addEventListener('click', async () => {
    dbg('ui', '点击 → 清空日志');
    await DBG.clear();
    dbg('ui', '日志已清空，从这里开始新一轮测试');
    renderDebug();
    toast('日志已清空');
  });
  $('dbgCopy').addEventListener('click', async () => {
    dbg('ui', '点击 → 复制日志');
    const text = await DBG.text();
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制 ' + text.split('\n').length + ' 行');
    } catch {
      // 剪贴板被拒时选中文本，让用户自己 Ctrl+C
      const r = document.createRange();
      r.selectNodeContents($('dbgLog'));
      const sel = getSelection();
      sel.removeAllRanges(); sel.addRange(r);
      toast('已选中，按 Ctrl+C 复制');
    }
  });
  $('dbgTestTask').addEventListener('click', async () => {
    dbg('ui', '点击 → 测试写任务文件（跳过点击链路）');
    const r = await send('hash-task', {
      // 仅用于生成自检任务文件，不要求该 release 真实存在；与当前版本保持一致即可
      // 版本号从 manifest 读，别再手写：以前每次发版都要回来改这一行
      url: (() => {
        const v = ext.runtime.getManifest().version;
        return 'https://github.com/morangsu/mirror-fastlane/releases/download/v' + v +
          '/mirror-fastlane-edge-' + v + '.zip';
      })(),
      name: 'mfl-debug-selftest.zip',
      source: 'debug 自检',
      sourceKind: 'manual',
    });
    toast(r && r.ok ? '已写出任务文件，看日志里的落盘路径' : '写入失败：' + ((r && (r.reason || r.error)) || '未知'));
    renderDebug();
  });
  $('dbgExport').addEventListener('click', async () => {
    dbg('ui', '点击 → 导出日志');
    const text = await DBG.text();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mfl-debug-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.txt';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    toast('已导出日志文件');
  });

  dbg('ui', '设置页已打开', { href: location.href });
  renderDebug();
  setInterval(() => { if (!document.hidden) renderDebug(); }, 4000);
}

applyI18n();
refresh().then(async () => {
  // 每次打开设置页都按浏览器的真实权限校正一次：
  // 修掉历史版本留下的「存储里说已授权、其实浏览器没给权限」——那种行会显示「未测速」但测不了
  try { await send('refresh-permissions'); } catch (e) { dbg('ui', '权限校正失败', String(e && e.message ? e.message : e)); }
});
