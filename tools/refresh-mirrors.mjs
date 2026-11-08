#!/usr/bin/env node
/* 刷新镜像清单：拉 git.mxg.pub 的成功列表 → 合并进 data/builtin-mirrors.json
 *
 * 清单 = 「手工精选」∪「源当前 success」：
 *   - 没有 auto 字段（或 auto:false）的条目 = 手工精选，本脚本永不自作主张删掉；
 *   - auto:true 的条目 = 之前从源加进来的，源一旦不再给出就从文件里去掉 ——
 *     这是扩展侧「连续 24h 缺失才移除」唯一的输入来源（否则删除功能永远不会触发）。
 *
 * 用法：
 *   node tools/refresh-mirrors.mjs                 # 合并写入 data/builtin-mirrors.json
 *   node tools/refresh-mirrors.mjs --out <path>    # 写到指定文件（测试用）
 *   node tools/refresh-mirrors.mjs --replace       # 整份替换成源数据（会丢精选，慎用）
 *   node tools/refresh-mirrors.mjs --dry           # 只打印结果，不写文件
 *   node tools/refresh-mirrors.mjs --from <file>   # 离线：从本地 JSON 读源数据
 *   MFL_MIRROR_SOURCE=<url> node tools/...         # 覆盖数据源
 *
 * 安全：源解析后没有任何可用镜像 → 直接抛错退出，绝不覆盖（避免一次坏响应把清单清空）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MFL = require('../lib/core.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SRC = process.env.MFL_MIRROR_SOURCE || 'https://git.mxg.pub/api/github/list';
const MAX_MIRRORS = 60;   // 与扩展存在集合上限一致
const FROM_IDX = process.argv.indexOf('--from');
const FROM = FROM_IDX >= 0 ? process.argv[FROM_IDX + 1] : null;   // 离线：--from <本地json>
const OUT_IDX = process.argv.indexOf('--out');
const OUT = OUT_IDX >= 0 ? process.argv[OUT_IDX + 1] : null;

/** 兼容 {data:[...]} / {mirrors:[...]} / [...] */
function pickArray(d) {
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.data)) return d.data;
  if (d && Array.isArray(d.mirrors)) return d.mirrors;
  return [];
}

/** status 为空 / success / ok / 200 / true 视为成功（容忍 "SUCCESS " 这类空白） */
function isSuccess(s) {
  const v = String(s == null ? '' : s).trim().toLowerCase();
  return v === '' || v === 'success' || v === 'ok' || v === '200' || v === 'true';
}

async function main() {
  const dry = process.argv.includes('--dry');
  const replace = process.argv.includes('--replace');
  const outPath = OUT ? path.resolve(ROOT, OUT) : path.join(ROOT, 'data', 'builtin-mirrors.json');
  if (FROM_IDX >= 0 && !FROM) throw new Error('--from 后面要跟本地 JSON 文件路径');
  if (OUT_IDX >= 0 && !OUT) throw new Error('--out 后面要跟输出文件路径');

  /* ---------------------------- 1. 取源数据 ---------------------------- */
  let data;
  if (FROM) {
    data = JSON.parse(fs.readFileSync(path.resolve(ROOT, FROM), 'utf8'));
  } else {
    const res = await fetch(SRC, {
      headers: { accept: 'application/json', 'user-agent': 'mirror-fastlane-refresh' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error('源返回 HTTP ' + res.status);
    data = await res.json();
  }

  const success = [];
  const srcHosts = new Set();
  for (const it of pickArray(data)) {
    const isStr = typeof it === 'string';
    if (!isStr && !isSuccess(it && it.status)) continue;   // 只要成功项
    const base = MFL.normalizeBase(isStr ? it : (it && (it.base || it.url)));
    if (!base) continue;                                   // 非法/非 https 丢弃
    const h = MFL.hostOf(base);
    if (!h || srcHosts.has(h)) continue;                   // 按 host 去重
    srcHosts.add(h);
    success.push({ name: (it && it.name) || h, base });
  }
  // 源为空 → 拒绝写入。否则会把所有 auto 条目当成「源已撤下」而清掉
  if (!success.length) throw new Error('源解析后没有可用镜像，拒绝写入');

  /* ------------------------- 2. 读现有清单拆分 ------------------------- */
  let existing = [];
  if (!replace && fs.existsSync(outPath)) {
    try {
      const cur = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      existing = (Array.isArray(cur.mirrors) ? cur.mirrors : []).filter(m => m && MFL.normalizeBase(m.base));
    } catch (e) {
      console.warn('现有清单解析失败，按空清单处理：', e.message);
    }
  }
  const curated = [];   // 手工精选：永不删
  const autoOld = [];   // 以前从源加的：源不认了就删
  for (const m of existing) {
    const base = MFL.normalizeBase(m.base);
    (m.auto === true ? autoOld : curated).push(Object.assign({}, m, { base }));
  }

  /* --------------------------- 3. 合并输出 --------------------------- */
  const mirrors = [];
  const used = new Set();
  const put = m => {
    const h = MFL.hostOf(m.base);
    if (!h || used.has(h)) return false;
    used.add(h); mirrors.push(m); return true;
  };

  // ① 手工精选打头，永不删
  for (const m of curated) { if (mirrors.length >= MAX_MIRRORS) break; put(m); }

  // ② 其余整段由源「覆盖」：按 git.mxg.pub 当前的 success 顺序重写，
  //    旧地址只要不在这次 success 里就自然消失（不再是把旧条目留着、只往后追加）。
  //    已在文件里的镜像沿用原对象（保留名字/备注等），地址变了则由新地址顶上。
  const oldByHost = new Map();
  for (const m of autoOld) oldByHost.set(MFL.hostOf(m.base), m);
  let added = 0;
  for (const s of success) {
    if (mirrors.length >= MAX_MIRRORS) break;
    const h = MFL.hostOf(s.base);
    if (used.has(h)) continue;                    // 与精选同 host：用精选那条，不重复
    const old = oldByHost.get(h);
    if (old) put(old);                            // 源仍给出这个地址：保留原有条目
    else if (put({ name: s.name, base: s.base, auto: true })) added++;
  }
  // 统计「这次被源撤下」的旧 auto 条目（含地址已变更、被新地址顶替的）
  let dropped = 0;
  for (const m of autoOld) if (!srcHosts.has(MFL.hostOf(m.base))) dropped++;

  const out = {
    updated: new Date().toISOString().slice(0, 10),
    note: '手工精选（无 auto 字段）永不删；其余条目整段由 git.mxg.pub 的当前 success 覆盖（auto:true），源撤下即消失。',
    mirrors,
  };
  const json = JSON.stringify(out, null, 2) + '\n';

  const summary = `精选 ${curated.length} + 源 ${success.length} → 共 ${mirrors.length}（新增 ${added}，移除 ${dropped}）`;
  if (dry) { process.stdout.write(json); console.error('[dry] ' + summary); return; }

  const before = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
  const strip = s => s.replace(/"updated":\s*"[^"]*",?\s*/, '');
  if (strip(before) === strip(json)) { console.log(`无变化（${mirrors.length} 个镜像），跳过写入`); return; }

  fs.writeFileSync(outPath, json, 'utf8');
  console.log(`写出 ${path.relative(ROOT, outPath)}：${summary}`);
}

main().catch(e => { console.error('refresh 失败：', e.message); process.exit(1); });
