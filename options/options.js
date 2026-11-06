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

async function send(type, extra) {
  const r = await ext.runtime.sendMessage(Object.assign({ type }, extra || {}));
  if (r && r.state) { state = r.state; render(); }
  return r;
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
  $('remoteUrl').value = (s.remoteList && s.remoteList.url) || '';
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
    ? (lf.ok ? MFL.relativeTime(lf.at) + '，经 ' + (lf.via || '直连') + '，新增 ' + lf.added + ' 个' : MFL.relativeTime(lf.at) + '，全部失败')
    : '从未';

  $('diag').textContent = '探测模式 ' + (s.probeMode === 'interval' ? '定时/' + s.probeIntervalMin + ' 分钟' : '仅按需') +
    '；上次测速 ' + MFL.relativeTime(state.lastProbe);

  renderMirrors();
  $('probeInterval').disabled = s.probeMode !== 'interval';
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
    await send('remove-mirror', { id });
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
  try {
    return await ext.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

/** 哈希功能要用 api.github.com；没这一步权限，任务文件里的 expected 永远是 null */
async function ensureApiPermission() {
  const origins = ['https://api.github.com/*'];
  try {
    if (await ext.permissions.contains({ origins })) return true;
    return await ext.permissions.request({ origins });
  } catch {
    return false;
  }
}

async function toggleHashFlag(flag, el) {
  if (el.checked && !(await ensureApiPermission())) {
    el.checked = false;
    return toast('未获得 api.github.com 授权，取不到期望哈希');
  }
  await send('save-settings', { patch: { hash: Object.assign({}, state.settings.hash, { [flag]: el.checked }) } });
  if (flag === 'auto' && el.checked && !(state.settings.hash && state.settings.hash.enabled)) {
    toast('还要打开上面的「启用哈希校验」');
  }
}

$('hashEnabled').addEventListener('change', e => toggleHashFlag('enabled', e.target));
$('hashAuto').addEventListener('change', e => toggleHashFlag('auto', e.target));

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
  await send('save-settings', { patch: { remoteList: Object.assign({}, state.settings.remoteList, { enabled: e.target.checked }) } });
});

$('remoteUrl').addEventListener('change', async e => {
  const url = e.target.value.trim();
  if (url && !/^https:\/\//i.test(url)) return toast('清单地址必须是 https://');
  await send('save-settings', { patch: { remoteList: Object.assign({}, state.settings.remoteList, { url }) } });
});

$('fetchList').addEventListener('click', async () => {
  // 先把输入框里的内容落盘：用户常常输入完直接点按钮，input 的 change 还没触发，
  // 后台读到的还是旧值（甚至空地址），就会报「未启用 / 地址为空」。
  const url = $('remoteUrl').value.trim();
  if (url && !/^https:\/\//i.test(url)) return toast('清单地址必须是 https://');
  const enabled = $('remoteEnabled').checked;
  if (!enabled) return toast('请先勾选「启用远程清单」');
  if (!url) return toast('请先填写清单地址');

  await send('save-settings', {
    patch: { remoteList: Object.assign({}, state.settings.remoteList, { enabled, url }) },
  });

  $('fetchList').disabled = true;
  const r = await send('fetch-list');
  $('fetchList').disabled = false;

  const REASON = {
    'not-enabled': '未启用远程清单',
    'no-url': '清单地址为空',
    'all-failed': '所有来源都失败（镜像未授权或地址不可达）',
    disabled: '未启用远程清单',
  };
  if (r && r.ok) toast('已通过 ' + r.via + ' 获取，新增 ' + r.added + ' 个');
  else toast('获取失败：' + (REASON[r && r.reason] || (r && r.reason) || '未知'));
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
  ext.tabs.create({ url: ext.runtime.getURL('verify/verify.html') });
});

refresh();
