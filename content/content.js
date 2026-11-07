/* 镜像快车道 - 页面标记与点击提示 */
(function () {
  'use strict';
  const ext = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;
  // 调试日志：正式包里 DBG 是空实现，写不写都不影响
  const D = (typeof DBG !== 'undefined') ? DBG : { log() {} };
  // 镜像还原：DNR 不改 DOM，但如果页面上 href 本身已被代理/别的脚本改写，
  // 就要先把 https://<mirror>/https://github.com/... 还原成官方直链再识别。
  const NORM = (typeof MFL !== 'undefined' && MFL.normalizeGitHubUrl)
    ? MFL.normalizeGitHubUrl
    : (u => String(u || ''));

  const SEL_RELEASE = 'a[href*="/releases/download/"]';
  const SEL_ARCHIVE = 'a[href^="/archive/"], a[href*="codeload.github.com"]';
  const MARK_ATTR = 'data-mfl-marked';

  let info = { active: false, markLinks: true, clickToast: true, codeload: false, hashAuto: false, best: null };
  let started = false;
  let infoFlight = null;

  /**
   * 向后台重取一次状态。info 原本只在页面加载时读一次：用户开着 GitHub 页面
   * 去设置里打开「自动校验」，回来直接点下载，拿到的还是过期的 hashAuto:false，
   * 于是白白漏掉一次任务登记。这里在点击时和设置变更时各补一次。
   */
  function refreshInfo(timeoutMs) {
    if (infoFlight) return infoFlight;   // 并发点击/广播只发一次请求
    const call = (async () => {
      try {
        const r = await ext.runtime.sendMessage({ type: 'badge-info' });
        if (r && typeof r === 'object') {
          const before = info.hashAuto;
          info = Object.assign(info, r);
          if (before !== info.hashAuto) {
            D.log('content', '页面内自动校验状态已更新', { hashAuto: info.hashAuto, hash: info.hash });
          }
        }
      } catch (e) {
        D.log('content', '刷新状态失败，沿用上次结果', String(e && e.message ? e.message : e));
      }
    })();
    // 后台万一没响应，不能把点击上报卡死；超时就沿用已有 info
    const guard = new Promise(res => setTimeout(res, timeoutMs || 1500));
    infoFlight = Promise.race([call, guard]).then(() => { infoFlight = null; });
    return infoFlight;
  }

  function pill(text, title) {
    const el = document.createElement('span');
    el.className = 'mfl-badge';
    el.textContent = text;
    el.title = title || '';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  function decorate(a, kind) {
    if (!a || a.getAttribute(MARK_ATTR)) return;
    if (!a.href) return;
    a.setAttribute(MARK_ATTR, '1');
    // 只标记真正指向 github 的链接，避免误伤；镜像化过的 href 先还原再判断
    if (!/^https:\/\/(github\.com|codeload\.github\.com)\//.test(NORM(a.href))) return;

    const label = kind === 'archive' ? '镜像·源码' : '镜像';
    const tip = info.best
      ? '该下载将由 ' + info.best.name + '（' + info.best.host + '）代理'
      : '将自动选择可用镜像';
    const el = pill(label, tip);
    if (a.parentNode) a.parentNode.insertBefore(el, a.nextSibling);
  }

  function scan() {
    if (!info.active || !info.markLinks) return;
    document.querySelectorAll(SEL_RELEASE).forEach(a => decorate(a, 'release'));
    if (info.codeload) document.querySelectorAll(SEL_ARCHIVE).forEach(a => decorate(a, 'archive'));
  }

  function hasDownloads() {
    return !!document.querySelector(SEL_RELEASE) || (info.codeload && !!document.querySelector(SEL_ARCHIVE));
  }

  /* ------------------------------- 点击提示 ------------------------------- */

  function nameOf(url) {
    try {
      const seg = new URL(url).pathname.split('/').pop() || '';
      return decodeURIComponent(seg);
    } catch { return ''; }
  }

  function toast(text, kind) {
    let box = document.getElementById('mfl-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'mfl-toast';
      document.documentElement.appendChild(box);
    }
    box.className = 'mfl-toast ' + (kind || '');
    box.textContent = text;
    box.style.opacity = '1';
    clearTimeout(box._t);
    box._t = setTimeout(() => { box.style.opacity = '0'; }, 2600);
  }

  document.addEventListener('click', async ev => {
    const a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
    if (!a || !a.href) return;
    // href 可能被改写成「镜像域名 + 原链」；先还原，后面一律用官方直链
    const href = NORM(a.href);
    const restored = href !== a.href;
    const isRelease = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//.test(href);
    const maybeArchive = /^https:\/\/(codeload\.github\.com|github\.com\/[^/]+\/[^/]+\/archive\/)/.test(href);
    if (!isRelease && !maybeArchive) return;

    // 设置可能是在页面打开之后才改的，先对齐最新状态再决定是否登记任务
    await refreshInfo(1500);
    if (maybeArchive && !info.codeload) return;

    D.log('content', '捕获到下载链接点击', {
      href, rawHref: restored ? a.href : undefined, restored,
      name: nameOf(href), hashAuto: info.hashAuto, hash: info.hash,
      clickToast: info.clickToast, active: info.active,
    });

    // 上报意图与「是否弹提示」无关：以前两者绑在一起，用户关掉点击提示后
    // 任务文件就再也不生成了。这里拆开，hashAuto 开就一定上报。
    if (info.hashAuto) {
      try {
        const p = ext.runtime.sendMessage({ type: 'intent', url: href, name: nameOf(href) });
        if (p && typeof p.then === 'function') {
          p.then(r => D.log('content', 'intent 返回', r))
            .catch(e => D.log('content', 'intent 失败', String(e && e.message ? e.message : e)));
        } else {
          D.log('content', 'intent 已发送（非 Promise 接口）');
        }
      } catch (e) { D.log('content', 'intent 发不出去', String(e)); }
    } else {
      const h = info.hash || {};
      const miss = [];
      if (!h.enabled) miss.push('启用哈希校验');
      if (!h.auto) miss.push('下载时写校验任务');
      D.log('content', '未上报：自动校验没开', {
        hashAuto: info.hashAuto, hash: h,
        need: miss.length ? '去设置页勾「' + miss.join('」「') + '」，或点「一键开启」' : '检查后台状态',
      });
    }

    if (!info.active || !info.clickToast) return;
    if (!info.best) {
      toast('所有镜像不可用，本次走主站', 'warn');
      return;
    }
    toast('已切换到镜像：' + info.best.name, 'ok');
  }, true);

  /* --------------------------------- 启动 -------------------------------- */

  async function load() {
    try {
      const r = await ext.runtime.sendMessage({ type: 'badge-info' });
      if (r && typeof r === 'object') info = Object.assign(info, r);
      D.log('content', '读到扩展状态', {
        active: info.active, hashAuto: info.hashAuto, hash: info.hash,
        codeload: info.codeload, best: info.best && info.best.host, href: location.href,
      });
    } catch (e) {
      D.log('content', '读扩展状态失败（后台未就绪？）', String(e && e.message ? e.message : e));
    }
    started = true;

    // 停用或关掉"标记链接"时，把之前插的徽章收回去
    if (!info.active || !info.markLinks) {
      document.querySelectorAll('.mfl-badge').forEach(el => el.remove());
      document.querySelectorAll('[' + MARK_ATTR + ']').forEach(el => el.removeAttribute(MARK_ATTR));
      if (!info.active) { D.log('content', '扩展未生效，不标记', info); return; }
    }

    scan();
    D.log('content', '页面扫描', {
      active: info.active, markLinks: info.markLinks, codeload: info.codeload,
      hashAuto: info.hashAuto, best: info.best && info.best.host,
      releaseLinks: document.querySelectorAll(SEL_RELEASE).length,
    });
    if (hasDownloads()) {
      try { ext.runtime.sendMessage({ type: 'maybe-probe' }); } catch {}
    }
  }

  // 设置页改了开关或授权后，已经打开的 GitHub 标签页立刻跟上，不必手动刷新页面。
  // 内容脚本可以直接用 chrome.storage，不需要额外申请 tabs 权限。
  if (ext.storage && ext.storage.onChanged) {
    try {
      ext.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes || !changes.settings) return;
        D.log('content', '检测到设置变更，重新读取状态');
        refreshInfo(2000).then(() => { if (info.active && info.markLinks) scan(); });
      });
    } catch { /* 个别浏览器不给内容脚本 storage，忽略；点击时还有一次兜底 */ }
  }

  const mo = new MutationObserver(() => {
    if (!started) return;
    if (scan._t) clearTimeout(scan._t);
    scan._t = setTimeout(scan, 180);
  });

  load().then(() => {
    mo.observe(document.documentElement, { childList: true, subtree: true });
  });

  document.addEventListener('turbo:load', load);
  document.addEventListener('pjax:end', load);
})();
