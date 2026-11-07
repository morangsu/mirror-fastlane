/* 镜像快车道 - 弹窗 */
'use strict';

const ext = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;
const dbg = (area, msg, data) => { if (typeof DBG !== 'undefined') DBG.log(area, msg, data); };

const $ = id => document.getElementById(id);

function dotClass(s) {
  if (!s.settings.enabled) return 'dot off';
  if (!s.inWindow) return 'dot warn';
  if (!s.ruleInfo || !s.ruleInfo.count) return 'dot warn';
  return 'dot on';
}

function render(s) {
  $('dot').className = dotClass(s);
  $('best').textContent = (s.ruleInfo && s.ruleInfo.best)
    ? s.ruleInfo.best.name + ' · ' + MFL.formatKbps(bestKbps(s))
    : '未启用';
  $('rules').textContent = String((s.ruleInfo && s.ruleInfo.count) || 0);
  $('probe').textContent = MFL.relativeTime(s.lastProbe);

  const enabled = !!s.settings.enabled;
  $('enabled').checked = enabled;

  const hints = [];
  if (!s.inWindow) hints.push('当前不在生效时段：' + s.settings.activeWindow.start + '–' + s.settings.activeWindow.end);
  const noPerm = s.mirrors.filter(m => m.enabled && !m.permitted).length;
  if (noPerm) hints.push(noPerm + ' 个镜像尚未授权访问，去设置页授权');
  if (!s.mirrors.some(m => m.enabled && m.healthy)) hints.push('没有可用镜像，下载将走主站');
  if (s.settings.probeMode === 'ondemand') hints.push('探测模式：仅按需（打开 GitHub 页面时）');
  $('hint').textContent = hints.join('；');
}

function bestKbps(s) {
  const base = s.ruleInfo && s.ruleInfo.best && s.ruleInfo.best.base;
  // 按 host 找，不用名字：用户可能给镜像改了名，也可能两个镜像同名
  const m = base ? s.mirrors.find(x => MFL.hostOf(x.base) === MFL.hostOf(base)) : null;
  return m && m.stats ? m.stats.kbps : 0;
}

async function refresh() {
  const s = await ext.runtime.sendMessage({ type: 'get-state' });
  if (s && s.settings) render(s);
}

$('enabled').addEventListener('change', async e => {
  dbg('ui', '弹窗 → 总开关', { checked: e.target.checked });
  await ext.runtime.sendMessage({ type: 'save-settings', patch: { enabled: e.target.checked } });
  refresh();
});

$('open').addEventListener('click', () => {
  dbg('ui', '弹窗 → 打开设置');
  ext.runtime.openOptionsPage();
});

$('probeNow').addEventListener('click', async () => {
  dbg('ui', '弹窗 → 立即测速');
  $('probeNow').disabled = true;
  $('probeNow').textContent = '测速中…';
  try {
    const r = await ext.runtime.sendMessage({ type: 'probe-all' });
    dbg('ui', '弹窗 → 测速结果', { probed: r && r.probed, rules: r && r.rules && r.rules.count });
  } catch (e) {
    dbg('ui', '弹窗 → 测速失败', String(e && e.message ? e.message : e));
  }
  $('probeNow').disabled = false;
  $('probeNow').textContent = '立即测速';
  refresh();
});

dbg('ui', '弹窗已打开');
refresh();
