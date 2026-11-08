/* 镜像快车道 - 设置页 */
'use strict';

const ext = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;
const $ = id => document.getElementById(id);

let state = null;

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2200);
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
  if (!m.enabled) return '已停用';
  if (!m.permitted) return '需授权';
  if (!m.healthy) return '不可用';
  if (!m.stats || !m.stats.lastProbe) return '未测速';
  return '可用';
}

function statusClass(m) {
  if (!m.enabled) return 'tag';
  if (!m.permitted) return 'tag warn';
  if (!m.healthy) return 'tag err';
  if (!m.stats || !m.stats.lastProbe) return 'tag';
  return 'tag ok';
}

function sourceLabel(s) {
  return s === 'builtin' ? '内置' : s === 'remote' ? '远程' : '手动';
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

    // 速度 / 延迟
    const tdSpeed = document.createElement('td');
    tdSpeed.textContent = m.stats && m.stats.kbps ? MFL.formatKbps(m.stats.kbps) : '—';
    tr.appendChild(tdSpeed);

    const tdTtfb = document.createElement('td');
    tdTtfb.textContent = m.stats && m.stats.ttfb ? MFL.formatMs(m.stats.ttfb) : '—';
    tr.appendChild(tdTtfb);

    // 操作
    const tdAct = document.createElement('td');
    if (!m.permitted) tdAct.appendChild(mkBtn('授权', 'grant', m.id, ''));
    tdAct.appendChild(mkBtn('测速', 'probe', m.id, ''));
    tdAct.appendChild(mkBtn('删除', 'remove', m.id, 'danger'));
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
  $('ruleTag').textContent = !state.inWindow ? '时段外' : (ri.count ? '生效中' : '无可用');
  $('ruleTag').className = 'tag ' + (!state.inWindow ? 'warn' : ri.count ? 'ok' : 'err');

  let routeText = '';
  if (ri.best) {
    routeText = '直链走 ' + ri.best.name;
    if (ri.archive && ri.archive.host !== ri.best.host) routeText += '，源码包走 ' + ri.archive.name;
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

  renderMirrors();
  $('probeInterval').disabled = s.probeMode !== 'interval';
  updateHashStatus();   // 异步刷新，不阻塞界面渲染
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
    btn.disabled = false; btn.textContent = '测速';
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
      await send('update-mirror', { id, permitted: true });
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
    if (await ext.permissions.contains({ origins })) result = true;
    else result = await ext.permissions.request({ origins });
  } catch (e) {
    dbg('perm', 'api.github.com 授权异常', String(e && e.message ? e.message : e));
  }
  dbg('perm', 'api.github.com 权限', { granted: result, origins });
  return result;
}

async function toggleHashFlag(flag, el) {
  dbg('ui', '切换哈希开关 → ' + flag, { checked: el.checked });
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

  if (el.checked && !(await ensureApiPermission())) {
    el.checked = false;
    return toast('未获得 api.github.com 授权，取不到期望哈希');
  }

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
  $('hashStatusTag').textContent = ready ? '已就绪' : '未就绪';
  $('hashStatusTag').className = 'tag ' + (ready ? 'ok' : 'err');
  $('hashStatusHint').textContent = ready
    ? '点击 GitHub 下载链接会自动写任务文件；' + (hasToken ? 'Token 已配置' : '未填 Token（匿名 60 次/小时，够测试）')
    : '还差：' + missing.join('、');
}

$('enableAutoHash').addEventListener('click', async () => {
  dbg('ui', '点击 → 一键开启自动校验');
  // permissions.request 必须在用户手势的调用栈里发起，所以先申请再保存
  if (!(await ensureApiPermission())) return toast('未获得 api.github.com 授权，取不到期望哈希');
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
  $('probeNow').disabled = false; $('probeNow').textContent = '立即测速全部';
  toast('测速完成');
});

$('grantAll').addEventListener('click', async () => {
  dbg('ui', '点击 → 一键授权内置镜像');
  const targets = (state.mirrors || []).filter(m => m.source === 'builtin' && !m.permitted);
  if (!targets.length) return toast('内置镜像都已授权');
  const origins = targets.map(m => MFL.originPattern(m.base)).filter(Boolean);
  let granted = false;
  try {
    granted = await ext.permissions.request({ origins });
  } catch (e) {
    return toast('授权失败：' + (e && e.message ? e.message : e));
  }
  if (!granted) return toast('未获得授权');
  await send('refresh-permissions');
  toast('已授权 ' + origins.length + ' 个域名，开始测速…');
  await send('probe-all');
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
      url: 'https://github.com/morangsu/mirror-fastlane/releases/download/v1.4.6/mirror-fastlane-edge-1.4.6.zip',
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

refresh();
