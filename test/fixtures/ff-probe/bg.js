/* Firefox 端探测：downloads API 能不能用 data: URL 静默落盘 */
(async () => {
  const out = {
    ua: navigator.userAgent,
    api: typeof browser !== 'undefined' ? 'browser' : (typeof chrome !== 'undefined' ? 'chrome' : 'none'),
    hasDownloads: false,
    hasCreateObjectURL: typeof URL.createObjectURL === 'function',
    ts: Date.now(),
  };

  try {
    out.hasDownloads = !!(browser.downloads && browser.downloads.download);
  } catch (e) { out.dlErr = String(e && e.message || e); }

  const dataUrl = obj =>
    'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(obj));

  // 1) data: URL + 子目录 + 指定文件名
  try {
    out.dataId = await browser.downloads.download({
      url: dataUrl({ kind: 'firefox-data', detail: out }),
      filename: '_mfl-ff/data.json',
      conflictAction: 'overwrite',
      saveAs: false,
    });
  } catch (e) { out.dataErr = String(e && e.message || e); }

  // 1b) data:base64 —— 排除"只是百分号编码不被接受"的可能
  try {
    const b = new TextEncoder().encode(JSON.stringify({ kind: 'firefox-data-b64', at: Date.now() }));
    let bin = ''; for (const x of b) bin += String.fromCharCode(x);
    out.dataB64Id = await browser.downloads.download({
      url: 'data:application/json;base64,' + btoa(bin),
      filename: '_mfl-ff/data-b64.json',
      conflictAction: 'overwrite', saveAs: false,
    });
  } catch (e) { out.dataB64Err = String(e && e.message || e).slice(0, 160); }

  // 2) blob: URL（Firefox 的 event page 有 DOM，可能有 createObjectURL）
  if (out.hasCreateObjectURL) {
    try {
      const b = new Blob([JSON.stringify({ kind: 'firefox-blob', detail: out })], { type: 'application/json' });
      const u = URL.createObjectURL(b);
      out.blobId = await browser.downloads.download({
        url: u, filename: '_mfl-ff/blob.json', conflictAction: 'overwrite', saveAs: false,
      });
    } catch (e) { out.blobErr = String(e && e.message || e); }
  }

  // 3) 下载状态回查
  await new Promise(r => setTimeout(r, 1500));
  try {
    const items = await browser.downloads.search({ limit: 10 });
    out.items = items.map(i => ({
      file: String(i.filename).split(/[\\/]/).pop(),
      state: i.state, err: i.error || '',
    }));
  } catch (e) { out.searchErr = String(e && e.message || e); }

  try { await browser.storage.local.set({ probe: out }); } catch {}
})();
