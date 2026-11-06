/* 镜像快车道 - 页面标记与点击提示 */
(function () {
  'use strict';
  const ext = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

  const SEL_RELEASE = 'a[href*="/releases/download/"]';
  const SEL_ARCHIVE = 'a[href^="/archive/"], a[href*="codeload.github.com"]';
  const MARK_ATTR = 'data-mfl-marked';

  let info = { active: false, markLinks: true, clickToast: true, codeload: false, hashAuto: false, best: null };
  let started = false;

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
    // 只标记真正指向 github 的链接，避免误伤
    if (!/^https:\/\/(github\.com|codeload\.github\.com)\//.test(a.href)) return;

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

  document.addEventListener('click', ev => {
    if (!info.active || !info.clickToast) return;
    const a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
    if (!a || !a.href) return;
    const isRelease = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//.test(a.href);
    const isArchive = info.codeload && /^https:\/\/(codeload\.github\.com|github\.com\/[^/]+\/[^/]+\/archive\/)/.test(a.href);
    if (!isRelease && !isArchive) return;

    // 记下这次下载指向的 GitHub 原链，供后台把 outbox 里的文件对回来做哈希校验
    if (info.hashAuto) {
      try {
        ext.runtime.sendMessage({ type: 'intent', url: a.href, name: nameOf(a.href) });
      } catch { /* 后台未就绪 */ }
    }

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
    } catch { /* 后台未就绪 */ }
    started = true;
    if (!info.active) {
      document.querySelectorAll('.mfl-badge').forEach(el => el.remove());
      document.querySelectorAll('[' + MARK_ATTR + ']').forEach(el => el.removeAttribute(MARK_ATTR));
      return;
    }
    scan();
    if (hasDownloads()) {
      try { ext.runtime.sendMessage({ type: 'maybe-probe' }); } catch {}
    }
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
