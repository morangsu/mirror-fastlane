/* 镜像快车道 - 哈希校验页 */
'use strict';

const ext = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;
const dbg = (area, msg, data) => { if (typeof DBG !== 'undefined') DBG.log(area, msg, data); };
const $ = id => document.getElementById(id);

let expected = '';
let actual = '';
let dirHandle = null;
let fileHandle = null;
const FILE_KEY = 'outboxFile';
let lastResults = [];
let pollTimer = null;

/* ------------------------------ 期望哈希 ------------------------------ */

async function ensureApiPermission() {
  const origins = ['https://api.github.com/*'];
  let ok = false;
  try {
    if (await ext.permissions.contains({ origins })) ok = true;
    else ok = await ext.permissions.request({ origins });
  } catch (e) {
    dbg('perm', '校验页 api.github.com 授权异常', String(e && e.message ? e.message : e));
  }
  dbg('perm', '校验页 api.github.com 权限', { granted: ok });
  return ok;
}

async function getToken() {
  const s = await ext.runtime.sendMessage({ type: 'get-state' });
  const on = s && s.settings && s.settings.hash && s.settings.hash.enabled;
  if (!on) return { enabled: false, token: '' };
  return { enabled: true, token: (s.settings.token || '').trim() };
}

$('fetchExpect').addEventListener('click', async () => {
  // 允许直接粘贴 IDM / 下载项里显示的镜像地址，先还原成 GitHub 官方直链
  const raw = $('releaseUrl').value.trim();
  const url = MFL.normalizeGitHubUrl(raw);
  dbg('ui', '校验页 → 取哈希', { url, restored: url !== raw });
  if (!url) return setExpectHint('请先填地址', true);
  $('fetchExpect').disabled = true;
  setExpectHint('正在取…');
  try {
    const { enabled, token } = await getToken();
    dbg('verify', '哈希开关/Token', { enabled, hasToken: !!token });
    if (!enabled) throw new Error('请先在设置页开启「哈希校验」');
    if (!(await ensureApiPermission())) throw new Error('未获得 api.github.com 访问授权');
    const r = await GHH.resolveExpected(url, token, MFL);
    expected = r.hash;
    $('expectHash').value = expected;
    $('expectName').textContent = r.name || '—';
    $('expectSource').textContent = r.source;
    $('expectInfo').style.display = 'grid';
    dbg('verify', '取到期望哈希', { hash: expected, name: r.name, source: r.source });

    // 顺带登记一次校验任务。IDM 等下载器会把下载完全接走，浏览器既没有
    // 页面点击事件、也没有 downloads 事件，扩展无从感知；但只要在这里填过
    // 地址，本地脚本就能按文件名把落盘文件（含 foo_2.zip 这类副本）对回来。
    const reg = await send('hash-task', {
      url,
      name: r.name || MFL.fileNameFromUrl(url) || '',
      expected: r.hash,
      source: r.source || '',
      sourceKind: r.sourceKind || '',
      repo: r.repo || '', tag: r.tag || '',
      assetId: r.assetId || 0, size: r.size || 0,
    });
    dbg('verify', '登记自动校验任务', {
      ok: !!(reg && reg.ok), name: r.name, reason: reg && (reg.reason || reg.error),
    });
    const tail = url !== raw ? '（镜像地址已还原为官方直链）' : '';
    setExpectHint((reg && reg.ok ? '已取得期望哈希，并已登记自动校验' : '已取得期望哈希（任务登记失败）') + tail, !(reg && reg.ok));
    compare();
  } catch (e) {
    dbg('verify', '取哈希失败', String(e && e.message ? e.message : e));
    setExpectHint('失败：' + (e && e.message ? e.message : e), true);
  } finally {
    $('fetchExpect').disabled = false;
  }
});

$('expectHash').addEventListener('input', () => {
  const v = MFL.stripSha256Prefix($('expectHash').value);
  expected = MFL.isValidSha256(v) ? v : '';
  compare();
});

function setExpectHint(msg, bad) {
  const el = $('expectHint');
  el.textContent = msg;
  el.style.color = bad ? '#cf222e' : '';
}

/* ------------------------------ 本地文件 ------------------------------ */

$('fileInput').addEventListener('change', async ev => {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  dbg('verify', '选择本地文件', { name: file.name, size: file.size });
  actual = '';
  $('actualName').textContent = file.name;
  $('actualSize').textContent = (file.size / 1048576).toFixed(2) + ' MB';
  $('fileInfo').style.display = 'grid';
  $('actualHash').textContent = '计算中…';
  const prog = $('prog');
  prog.style.display = 'block';
  prog.value = 0;
  try {
    actual = await SHA256.hashFile(file, (done, total) => {
      prog.value = total ? Math.round((done / total) * 100) : 0;
    });
    $('actualHash').textContent = actual;
    dbg('verify', '本地哈希算完', { hash: actual, verdict: expected ? (expected === actual ? '一致' : '不一致') : '无期望值' });
  } catch (e) {
    dbg('verify', '本地哈希计算失败', String(e && e.message ? e.message : e));
    $('actualHash').textContent = '计算失败：' + (e && e.message ? e.message : e);
  } finally {
    prog.style.display = 'none';
  }
  compare();
});

function compare() {
  const v = $('verdict');
  if (!expected) { v.className = 'verdict'; v.textContent = ''; return; }
  if (!actual) {
    v.className = 'verdict unknown';
    v.textContent = '已取得期望哈希，等待选择本地文件';
    return;
  }
  if (expected === actual) {
    v.className = 'verdict ok';
    v.textContent = '哈希一致，文件完整';
  } else {
    v.className = 'verdict bad';
    v.textContent = '哈希不一致！文件可能损坏或被篡改，建议重新下载';
  }
}

/* ------------------------------ 后台状态 ------------------------------ */

async function send(type, extra) {
  try {
    return await ext.runtime.sendMessage(Object.assign({ type }, extra || {}));
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

let lastTaskStamp = null;   // 8 秒轮询一次，只在任务状态真的变了才记日志

async function refreshState() {
  const st = await send('hash-state');
  if (!st || st.ok === false) return;
  const stamp = st.lastTask ? String(st.lastTask.at) + ':' + st.lastTask.name : 'none';
  if (stamp !== lastTaskStamp) {
    lastTaskStamp = stamp;
    dbg('verify', '后台任务状态变化', { intents: st.intents || 0, lastTask: st.lastTask || null });
  }

  const task = st.lastTask;
  if (task && task.at) {
    $('autoState').textContent = '最近写入：' + task.name;
    $('autoScan').textContent = MFL.relativeTime(task.at) + `，共 ${st.intents || 0} 条下载记录`;
  } else {
    $('autoState').textContent = '还没有写过任务文件';
    $('autoScan').textContent = `${st.intents || 0} 条下载记录`;
  }
}

/* ------------------------------ outbox ------------------------------ */

// 可信度标签：告诉用户这次"通过"到底是回源核对过的，还是只信了本地任务文件
const TRUST_META = {
  pass: { text: '已回源复核', cls: 'tag ok', tip: '脚本重新问了 api.github.com，官方摘要与任务文件一致' },
  'pass-unverified': { text: '未复核', cls: 'tag warn', tip: '没能回源核对，只信了本地任务文件里的值' },
  conflict: { text: '来源冲突', cls: 'tag fail', tip: '任务文件里的哈希与 GitHub API 不一致，文件可能被改过' },
  none: { text: '仅本地值', cls: 'tag muted', tip: '没拿到官方哈希，只算了本地值' },
};

function makeTrustBadge(trust) {
  const m = TRUST_META[trust];
  if (!m) return null;
  const s = document.createElement('span');
  s.className = m.cls;
  s.textContent = m.text;
  s.title = m.tip;
  s.style.marginLeft = '6px';
  return s;
}

function renderResults(list) {
  const wrap = $('resultWrap');
  const body = $('resultBody');
  body.textContent = '';
  if (!list.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';

  for (const e of list) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    const code = document.createElement('code');
    code.textContent = e.name;
    tdName.appendChild(code);
    const badge = makeTrustBadge(e.trust);
    if (badge) tdName.appendChild(badge);
    const p = document.createElement('div');
    p.style.color = 'var(--muted)';
    p.style.fontSize = '11px';
    p.textContent = e.path;
    tdName.appendChild(p);
    tr.appendChild(tdName);

    const tdHash = document.createElement('td');
    const hc = document.createElement('code');
    hc.textContent = e.hash ? e.hash.slice(0, 12) + '…' : '—';
    hc.style.fontSize = '11px';
    tdHash.appendChild(hc);
    tr.appendChild(tdHash);

    const tdTime = document.createElement('td');
    tdTime.textContent = MFL.relativeTime(e.ts);
    tr.appendChild(tdTime);

    const tdAct = document.createElement('td');
    if (e.hash) {
      const btn = document.createElement('button');
      btn.dataset.hash = e.hash;
      btn.dataset.name = e.name;
      btn.textContent = '比对';
      tdAct.appendChild(btn);
    }
    tr.appendChild(tdAct);

    body.appendChild(tr);
  }
  lastResults = list;
}

async function loadOutboxFile(fh) {
  const f = await fh.getFile();
  const text = await f.text();
  renderResults(text ? MFL.mergeOutbox(text.split(/\r?\n/), 200) : []);
}

async function loadOutbox() {
  if (!dirHandle) return;

  // 记录在 _mfl-tasks/outbox.txt；旧版本写在根目录，保留兼容
  let text = '';
  const tryRead = async (rel) => {
    try {
      const dir = rel ? await dirHandle.getDirectoryHandle(rel) : dirHandle;
      const fh = await dir.getFileHandle('outbox.txt');
      return await (await fh.getFile()).text();
    } catch { return null; }
  };

  text = (await tryRead('_mfl-tasks')) ?? (await tryRead(null)) ?? '';
  renderResults(text ? MFL.mergeOutbox(text.split(/\r?\n/), 200) : []);
}

/* ------------------------------ 目录授权 ------------------------------ */

let hintNodes = null;

function toast(msg) {
  const el = $('autoHint');
  if (!el) return;
  if (!hintNodes) hintNodes = Array.from(el.childNodes).map(n => n.cloneNode(true));
  el.textContent = msg;
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.replaceChildren(...hintNodes.map(n => n.cloneNode(true)));
  }, 5000);
}

$('pickFile').addEventListener('click', async () => {
  dbg('ui', '校验页 → 打开 outbox.txt');
  if (!window.showOpenFilePicker) {
    dbg('verify', '浏览器不支持 showOpenFilePicker');
    return alert('当前浏览器不支持文件选择器，请用「授权整个文件夹」或换 Chrome / Edge。');
  }
  let handles;
  try {
    handles = await window.showOpenFilePicker({
      multiple: false,
      types: [{ description: 'outbox.txt', accept: { 'text/plain': ['.txt'] } }],
    });
  } catch (e) {
    dbg('verify', '文件选择器取消/失败', String(e && e.name ? e.name : e));
    return;
  }
  const fh = handles[0];
  dbg('verify', '已选 outbox.txt', { name: fh.name });
  try { await IDB.put(FILE_KEY, fh); } catch { /* 存不了就只在本次有效 */ }
  fileHandle = fh;
  try {
    await loadOutboxFile(fh);
    dbg('verify', 'outbox 读取成功', { rows: lastResults.length });
    toast('已读取 ' + fh.name);
  } catch (e) {
    dbg('verify', 'outbox 读取失败', String(e && e.message ? e.message : e));
    toast('读取失败：' + (e && e.message ? e.message : e));
  }
});

$('pickDir').addEventListener('click', async () => {
  dbg('ui', '校验页 → 授权整个文件夹');
  if (!window.showDirectoryPicker) {
    dbg('verify', '浏览器不支持 showDirectoryPicker');
    alert('当前浏览器不支持目录授权（Firefox 没有 File System Access API）。\n'
      + '这里只影响"查看历史记录"，不影响自动校验——后者由本地脚本完成。');
    return;
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'read', id: 'mfl-outbox' });
  } catch (e) {
    // 浏览器会因为「目录含系统文件」直接拦下，这个拦截在浏览器侧，扩展改不了
    dbg('verify', '目录选择器结果', { error: e && e.name ? e.name : String(e), message: e && e.message ? e.message : '' });
    if (e && e.name !== 'AbortError') {
      toast('浏览器拒绝了这个目录，改用「打开 outbox.txt」');
    }
    return;
  }
  dbg('verify', '已选目录', { name: handle.name });

  // 允许选下载根目录（含 _mfl-tasks 子目录），也允许直接选 _mfl-tasks 本身
  const hasTaskDir = await (async () => {
    try { await handle.getDirectoryHandle('_mfl-tasks'); return true; } catch { return false; }
  })();
  const hasRootOutbox = await (async () => {
    try { await handle.getFileHandle('outbox.txt'); return true; } catch { return false; }
  })();
  dbg('verify', '目录内容检查', { hasTaskDir, hasRootOutbox });
  if (!hasTaskDir && !hasRootOutbox) {
    alert('这个文件夹里没有 _mfl-tasks 目录，也没有 outbox.txt。\n请选择下载根目录（脚本默认把记录放在其中的 _mfl-tasks 下）。');
    return;
  }

  try { await IDB.put(IDB.HANDLE_KEY, handle); } catch (e) {
    return alert('保存文件夹权限失败：' + (e && e.message ? e.message : e));
  }
  dirHandle = handle;
  await loadOutbox();
  toast('文件夹已记录，可以查看脚本写入的校验结果了');
});

$('reloadOutbox').addEventListener('click', async () => {
  dbg('ui', '校验页 → 重新读取');
  if (!fileHandle && !dirHandle) {
    try { fileHandle = await IDB.get(FILE_KEY); } catch { /* ignore */ }
    try { dirHandle = await IDB.get(IDB.HANDLE_KEY); } catch { /* ignore */ }
  }
  if (fileHandle) {
    try {
      await loadOutboxFile(fileHandle);
      return toast('已重新读取');
    } catch {
      fileHandle = null;
    }
  }
  if (!dirHandle) return toast('请先「打开 outbox.txt」或授权文件夹');
  await loadOutbox();
  toast('已重新读取');
});

$('forgetDir').addEventListener('click', async () => {
  dbg('ui', '校验页 → 忘记授权');
  if (!confirm('忘记已授权的文件/文件夹？之后需要重新选择才能查看历史记录。')) return;
  try { await IDB.del(IDB.HANDLE_KEY); } catch { /* ignore */ }
  try { await IDB.del(FILE_KEY); } catch { /* ignore */ }
  dirHandle = null;
  fileHandle = null;
  renderResults([]);
  toast('已忘记授权');
});

$('resultBody').addEventListener('click', ev => {
  const b = ev.target.closest('button[data-hash]');
  if (!b) return;
  dbg('ui', '校验页 → 比对历史记录', { name: b.dataset.name });
  if (!expected) return setExpectHint('请先取得或填写期望哈希', true);
  const v = $('verdict');
  if (b.dataset.hash === expected) {
    v.className = 'verdict ok';
    v.textContent = '脚本记录的哈希与期望值一致（' + b.dataset.name + '）';
  } else {
    v.className = 'verdict bad';
    v.textContent = '脚本记录的哈希与期望值不一致（' + b.dataset.name + '）';
  }
});

/* --------------------------------- 启动 -------------------------------- */

(async () => {
  dbg('ui', '校验页已打开');
  await refreshState();
  try {
    // 优先恢复 outbox.txt 的文件句柄：它不受「目录含系统文件」的限制
    fileHandle = await IDB.get(FILE_KEY).catch(() => null);
    if (fileHandle) {
      let perm = 'granted';
      if (typeof fileHandle.queryPermission === 'function') {
        perm = await fileHandle.queryPermission({ mode: 'read' });
      }
      if (perm === 'granted') await loadOutboxFile(fileHandle);
      else { fileHandle = null; toast('文件权限已失效，请重新选择 outbox.txt'); }
    } else {
      dirHandle = await IDB.get(IDB.HANDLE_KEY);
      if (dirHandle) {
        let perm = 'granted';
        if (typeof dirHandle.queryPermission === 'function') {
          perm = await dirHandle.queryPermission({ mode: 'read' });
        }
        if (perm === 'granted') await loadOutbox();
        else toast('文件夹读取权限已失效，请重新授权或改用「打开 outbox.txt」');
      }
    }
  } catch { /* ignore */ }
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refreshState().catch(() => {});
  }, 8000);
})();
