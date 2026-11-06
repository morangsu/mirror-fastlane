/* 真实网络下的"哈希来源复核"验证（可选，不进 npm test）
 *
 * 做两件事：
 *   1) 从 api.github.com 取一个真实 release 资产，下载它，用 real digest 写任务文件，
 *      脚本应当回源复核一致 → 校验通过；
 *   2) 同一个资产，把任务文件里的 expected 换掉，
 *      脚本应当发现"任务文件与 GitHub API 不一致" → 报来源冲突，而不是通过。
 *
 * 用法：node test/live-provenance.mjs [owner/repo]
 * 默认仓库 BurntSushi/ripgrep（资产较小，省流量）。
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(ROOT, 'hooks', 'hash-hook.ps1');
const REPO = process.argv[2] || 'BurntSushi/ripgrep';
const MAX_BYTES = 6 * 1024 * 1024;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (extra ? '  -> ' + extra : '')); console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); }
}

const bin = ['pwsh', 'powershell'].find(b => spawnSync(b, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).status === 0);
if (!bin) { console.error('找不到 pwsh / powershell'); process.exit(2); }

function runHook(dir, extra = '') {
  // 必须显式把子进程输出切成 UTF-8，否则中文日志在管道里是 ANSI 乱码
  const cmd = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & '${HOOK}' -DownloadDir '${dir}' -NoNotify${extra}`;
  const r = spawnSync(bin, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
    { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
  const outbox = join(dir, '_mfl-tasks', 'outbox.txt');
  return {
    out: (r.stdout || '') + (r.stderr || ''),
    outbox: existsSync(outbox) ? readFileSync(outbox, 'utf8').trim() : '',
    status: r.status,
  };
}

/*
 * 本机到 github.com / api.github.com 经常要过代理，Node 的 fetch 不读 http_proxy，
 * 所以统一走 curl：先吃环境代理，再显式试 Clash 默认端口。
 */
const CURL_PROXIES = [[], ['-x', 'http://127.0.0.1:7897']];

function curlJson(url) {
  for (const extra of CURL_PROXIES) {
    const r = spawnSync('curl', ['-sSL', '--max-time', '40',
      '-H', 'Accept: application/vnd.github+json', '-H', 'User-Agent: mfl-live-test',
      ...extra, url], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout && r.stdout.trim()) {
      try { return JSON.parse(r.stdout); } catch { /* 继续试下一个代理 */ }
    }
  }
  return null;
}

function download(url) {
  for (const extra of CURL_PROXIES) {
    const tmp = join(tmpdir(), 'mfl-live-dl-' + Date.now());
    const r = spawnSync('curl', ['-sSL', '--max-time', '60', '-o', tmp, ...extra, url], { encoding: 'utf8' });
    if (r.status === 0 && existsSync(tmp)) {
      const b = readFileSync(tmp);
      try { rmSync(tmp, { force: true }); } catch { }
      if (b.length > 0) return b;
    }
  }
  return null;
}

const dirs = [];
function makeCase(tag, name, expected, size, buf, meta) {
  const d = mkdtempSync(join(tmpdir(), 'mfl-live-' + tag + '-'));
  dirs.push(d);
  mkdirSync(join(d, 'Archives'), { recursive: true });
  mkdirSync(join(d, '_mfl-tasks'), { recursive: true });
  const file = join(d, 'Archives', name);
  writeFileSync(file, buf);
  writeFileSync(join(d, '_mfl-tasks', name + '.task.json'), JSON.stringify({
    v: 2, name, url: meta.url, expected, source: 'GitHub API digest', sourceKind: 'api-digest',
    repo: meta.repo, tag: meta.tag, assetId: meta.assetId, size, ts: Date.now(),
  }, null, 2));
  return d;
}

(async () => {
  console.log('仓库: ' + REPO);
  const rel = curlJson('https://api.github.com/repos/' + REPO + '/releases/latest');

  if (!rel || !rel.assets) { console.error('拿不到 release（网络/代理不通？）'); process.exit(1); }

  const asset = (rel.assets || [])
    .filter(a => a.digest && /^sha256:[a-f0-9]{64}$/.test(a.digest) && a.size > 0 && a.size <= MAX_BYTES)
    .sort((a, b) => a.size - b.size)[0];

  if (!asset) { console.error('该 release 没有带 digest 的小资产'); process.exit(1); }

  const digest = asset.digest.slice(7);
  console.log(`资产: ${asset.name}  ${(asset.size / 1024).toFixed(1)} KB  digest=${digest.slice(0, 16)}…`);

  const real = download(asset.browser_download_url);
  // 拿不到真实字节时，用占位内容跑"冲突/降级"两类用例（它们不依赖内容）
  const buf = real || Buffer.from('placeholder content for provenance test');
  if (real) {
    const local = createHash('sha256').update(real).digest('hex');
    ok('下载内容与官方 digest 一致（前置条件）', local === digest, local.slice(0, 16) + ' vs ' + digest.slice(0, 16));
  } else {
    console.log('  ! 无法下载资产（本机到 github.com 不通），跳过"真实字节"用例');
  }

  const meta = {
    url: asset.browser_download_url,
    repo: REPO, tag: rel.tag_name, assetId: asset.id,
  };

  if (real) {
    console.log('\n1. 正常任务：脚本回源复核');
    const d = makeCase('ok', asset.name, digest, asset.size, real, meta);
    const r = runHook(d);
    ok('脚本正常退出', r.status === 0, String(r.status));
    ok('日志显示已回源复核一致', /已回源 GitHub API 复核一致/.test(r.out), r.out.split('\n').slice(-4).join(' | '));
    ok('按资产 id 精确回源（不会被同名资产的其它版本顶掉）', /按 id 精确查/.test(r.out), r.out.split('\n').slice(-5).join(' | '));
    ok('outbox 记录了 ok', /\|ok\|/.test(r.outbox), r.outbox.slice(0, 120));
    ok('outbox 标记为已回源复核', /\|pass$/.test(r.outbox), r.outbox.slice(-40));
    ok('任务文件已消费', !existsSync(join(d, '_mfl-tasks', asset.name + '.task.json')));
  }

  console.log('\n2. 任务文件被改：expected 换成假值');
  {
    const fake = '0'.repeat(64);
    const d = makeCase('bad', asset.name, fake, asset.size, buf, meta);
    const r = runHook(d);
    ok('脚本正常退出', r.status === 0, String(r.status));
    ok('识别为哈希来源冲突', /哈希来源冲突|来源被改动/.test(r.out), r.out.split('\n').slice(-4).join(' | '));
    ok('按资产 id 精确回源', /按 id 精确查/.test(r.out), r.out.split('\n').slice(-5).join(' | '));
    ok('没有把它当成校验通过', !/校验通过/.test(r.out), r.out.split('\n').slice(-3).join(' | '));
  }

  console.log('\n3. 断网模拟：-NoNet 时不联网、且如实降级');
  {
    // 期望值取本地内容的哈希，这样无论网络是否可用，结论都应该落在"未复核"而不是"失败"
    const localDigest = createHash('sha256').update(buf).digest('hex');
    const d = makeCase('noNet', asset.name, localDigest, asset.size, buf, meta);
    const r = runHook(d, ' -NoNet');
    ok('标注为仅凭任务文件', /仅凭任务文件通过/.test(r.out), r.out.split('\n').slice(-3).join(' | '));
    ok('说明了未复核原因', /NoNet/.test(r.out), r.out.split('\n').slice(-2).join(' | '));
  }

  console.log('\n' + '-'.repeat(50));
  console.log(`通过 ${pass}  失败 ${fail}`);
  if (fail) { console.log('\n失败项：'); failures.forEach(f => console.log('  X ' + f)); }
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { } }
  process.exit(fail ? 1 : 0);
})();
