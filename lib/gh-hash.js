/* 镜像快车道 - 期望哈希解析（Service Worker 与校验页共用） */
'use strict';

(function (root) {
  const api = {};

  function apiHeaders(token) {
    const h = { Accept: 'application/vnd.github+json' };
    if (token) h.Authorization = 'Bearer ' + token;
    return h;
  }

  async function fetchJson(url, token) {
    const r = await fetch(url, { headers: apiHeaders(token), credentials: 'omit', cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  /** 从校验文件文本里取出目标文件的哈希 */
  function parseChecksumText(text, wantName) {
    const lines = String(text || '').split(/\r?\n/);
    const single = lines.map(l => l.trim()).filter(Boolean);
    // 单值边车文件：整份文件只有一行、且整行就是一个哈希（不带文件名）
    if (single.length === 1 && /^[a-f0-9]{64}$/i.test(single[0])) {
      return single[0].toLowerCase();
    }
    // 多行清单：<hash>  <*?>name
    for (const line of lines) {
      const m = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
      if (!m) continue;
      const name = m[2].split(/[\\/]/).pop();
      if (!wantName || name === wantName) return m[1].toLowerCase();
    }
    return null;
  }

  /**
   * 取得某个 release 资产的期望 SHA-256。
   * 优先级：API digest → 同名边车文件 → 汇总清单 → release body 里的哈希
   *
   * 除哈希本身，还带回"可被第三方独立复核的锚点"：
   *   repo / tag / assetId（数字，永不变）/ size
   * 这些字段会写进任务文件，供本地脚本回源 api.github.com 复核哈希来源，
   * 避免"只信任务文件里那句 expected"。
   *
   * sourceKind 表示来源强度：
   *   api-digest —— GitHub 自己算的摘要（最可信，改动资产必然变）
   *   sidecar    —— release 里作者提供的校验文件
   *   body       —— 作者写在 release 说明里的哈希（最弱）
   *
   * @returns {Promise<{hash:string,name:string,source:string,sourceKind:string,
   *                    repo:string,tag:string,assetId:number,size:number}>}
   */
  async function resolveExpected(input, token, MFL) {
    const lib = MFL || root.MFL;
    const target = lib.fileNameFromUrl(input) || '';
    const meta = lib.parseReleaseUrl(input);
    if (!meta) throw new Error('无法识别仓库地址');

    const base = 'https://api.github.com/repos/' + meta.owner + '/' + meta.repo;
    let rel;
    if (meta.tag) {
      rel = await fetchJson(base + '/releases/tags/' + encodeURIComponent(meta.tag), token);
    } else {
      const list = await fetchJson(base + '/releases?per_page=10', token);
      rel = (list || [])[0];
    }
    if (!rel) throw new Error('没有找到 release');

    const assets = rel.assets || [];
    const hit = target
      ? assets.find(a => a.name === target)
      : (assets.length === 1 ? assets[0] : null);

    // 所有结果都带上这组锚点，脚本据此回源核对
    const anchor = {
      repo: meta.owner + '/' + meta.repo,
      tag: String(rel.tag_name || meta.tag || ''),
      assetId: hit && hit.id ? Number(hit.id) : 0,
      size: hit && hit.size ? Number(hit.size) : 0,
    };

    // 1) API 直接给出 digest（新上传的资产 100% 覆盖）
    if (hit && hit.digest && /^sha256:/i.test(hit.digest)) {
      return Object.assign({
        hash: lib.stripSha256Prefix(hit.digest),
        name: hit.name,
        source: 'GitHub API digest',
        sourceKind: 'api-digest',
      }, anchor);
    }

    // 2) 边车文件与汇总清单
    const sidecarNames = [];
    if (hit) sidecarNames.push(hit.name + '.sha256', hit.name + '.sha256sum', hit.name + '.sha256.txt');
    sidecarNames.push('SHA256SUMS', 'sha256sums.txt', 'checksums.txt', 'SHA256SUMS.txt');

    const wantName = hit ? hit.name : target;
    for (const name of sidecarNames) {
      const a = assets.find(x => x.name.toLowerCase() === name.toLowerCase());
      if (!a) continue;
      let text = '';
      try {
        const r = await fetch(a.browser_download_url, { credentials: 'omit', cache: 'no-store' });
        if (!r.ok) continue;
        text = await r.text();
      } catch { continue; }
      const parsed = parseChecksumText(text, wantName);
      if (parsed) {
        return Object.assign({
          hash: parsed,
          name: wantName,
          source: '校验文件 ' + a.name,
          sourceKind: 'sidecar',
        }, anchor);
      }
    }

    // 3) release 正文里常写 "SHA256: <hash>"
    const body = String(rel.body || '');
    if (body) {
      const m = /sha-?256[^a-f0-9]{0,24}([a-f0-9]{64})/i.exec(body);
      if (m) {
        return Object.assign({
          hash: m[1].toLowerCase(),
          name: wantName,
          source: 'release 说明',
          sourceKind: 'body',
        }, anchor);
      }
    }

    throw new Error('该 release 没有提供可用于校验的哈希');
  }

  api.apiHeaders = apiHeaders;
  api.fetchJson = fetchJson;
  api.parseChecksumText = parseChecksumText;
  api.resolveExpected = resolveExpected;

  root.GHH = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
