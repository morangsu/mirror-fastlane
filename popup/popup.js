/* 镜像快车道 - 弹窗 */
'use strict';

const ext = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

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
  const name = s.ruleInfo && s.ruleInfo.best && s.ruleInfo.best.name;
  const m = s.mirrors.find(x => x.name === name);
  return m && m.stats ? m.stats.kbps : 0;
}

async function refresh() {
  const s = await ext.runtime.sendMessage({ type: 'get-state' });
  if (s && s.settings) render(s);
}

$('enabled').addEventListener('change', async e => {
  await ext.runtime.sendMessage({ type: 'save-settings', patch: { enabled: e.target.checked } });
  refresh();
});

$('open').addEventListener('click', () => {
  ext.runtime.openOptionsPage();
});

$('probeNow').addEventListener('click', async () => {
  $('probeNow').disabled = true;
  $('probeNow').textContent = '测速中…';
  await ext.runtime.sendMessage({ type: 'probe-all' });
  $('probeNow').disabled = false;
  $('probeNow').textContent = '立即测速';
  refresh();
});

refresh();
