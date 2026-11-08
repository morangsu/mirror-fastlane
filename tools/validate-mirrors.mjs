#!/usr/bin/env node
/* 校验镜像清单的 schema，供发版体检（tools/verify-release.mjs）与 CI 共用。
 *
 *   node tools/validate-mirrors.mjs                  # 校验 data/builtin-mirrors.json
 *   node tools/validate-mirrors.mjs --file <path>   # 校验指定文件（相对仓库根或绝对路径）
 *
 * 规则与 tools/refresh-mirrors.mjs / lib/core.js 保持一致：
 *   - 顶层 mirrors 为数组，1..60 条（与 refresh 的 MAX_MIRRORS 一致）
 *   - 每条 base 能被 normalizeBase 规范化成 https 根地址
 *   - 每条 name 为非空字符串；auto 若出现必须是布尔（可缺省）
 *   - 同 host 不重复；updated 为合法的 YYYY-MM-DD
 * 失败打印每一条具体原因并 exit 1；成功 exit 0。
 * 被 import 时只导出函数，不执行 CLI 逻辑。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MFL = require('../lib/core.js');
const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), '..');
const MIN_MIRRORS = 1;
const MAX_MIRRORS = 60;

/** 校验已解析的清单对象，返回错误字符串数组（空数组表示通过）。 */
export function validateMirrors(doc) {
  const errors = [];
  const at = i => `mirrors[${i}]`;

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return ['顶层必须是 JSON 对象'];
  }

  /* updated：格式 + 真实日期 */
  const u = doc.updated;
  if (typeof u !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(u)) {
    errors.push(`updated 必须是 YYYY-MM-DD 字符串（实际 ${JSON.stringify(u)}）`);
  } else {
    const [y, m, d] = u.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
      errors.push(`updated 不是有效日期：${u}`);
    }
  }

  /* mirrors：类型与数量 */
  const list = doc.mirrors;
  if (!Array.isArray(list)) {
    errors.push('顶层 mirrors 必须是数组');
    return errors;
  }
  if (list.length < MIN_MIRRORS) errors.push(`mirrors 至少 ${MIN_MIRRORS} 条，实际 ${list.length} 条`);
  if (list.length > MAX_MIRRORS) errors.push(`mirrors 最多 ${MAX_MIRRORS} 条，实际 ${list.length} 条`);

  const seen = new Map();  // host -> 首次出现的下标
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      errors.push(`${at(i)} 必须是对象`);
      continue;
    }

    if (typeof m.name !== 'string' || !m.name.trim()) {
      errors.push(`${at(i)}.name 必须是非空字符串（实际 ${JSON.stringify(m.name)}）`);
    }

    // auto 可缺省；出现就必须是布尔，不能是 0/1/"true" 这类替身
    if (Object.prototype.hasOwnProperty.call(m, 'auto') && typeof m.auto !== 'boolean') {
      errors.push(`${at(i)}.auto 只能是布尔值，可缺省（实际 ${JSON.stringify(m.auto)}）`);
    }

    if (typeof m.base !== 'string' || !m.base.trim()) {
      errors.push(`${at(i)}.base 必须是非空字符串（实际 ${JSON.stringify(m.base)}）`);
      continue;
    }
    const norm = MFL.normalizeBase(m.base);
    if (!norm) {
      errors.push(`${at(i)}.base 不是可规范化的 https URL：${JSON.stringify(m.base).slice(0, 120)}`);
      continue;
    }
    const host = MFL.hostOf(norm);
    if (!host) {
      errors.push(`${at(i)}.base 规范化后取不到 host：${norm}`);
      continue;
    }
    if (seen.has(host)) {
      errors.push(`${at(i)}.base 与 ${at(seen.get(host))}.base 的 host 重复（${host}）`);
    } else {
      seen.set(host, i);
    }
  }
  return errors;
}

/** 读文件 + JSON.parse + validateMirrors，返回 { errors, doc }。 */
export function validateMirrorsFile(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (e) { return { errors: [`无法读取 ${file}：${e.message}`], doc: null }; }
  let doc;
  try { doc = JSON.parse(text); }
  catch (e) { return { errors: [`${file} 不是合法 JSON：${e.message}`], doc: null }; }
  return { errors: validateMirrors(doc), doc };
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === HERE;
if (IS_MAIN) {
  const idx = process.argv.indexOf('--file');
  let file = null;
  if (idx >= 0) {
    file = process.argv[idx + 1];
    if (!file) {
      console.error('[validate-mirrors] FAIL: --file 后面要跟文件路径');
      process.exit(1);
    }
  }
  const target = file ? resolve(ROOT, file) : resolve(ROOT, 'data', 'builtin-mirrors.json');
  const label = relative(ROOT, target) || target;
  const { errors, doc } = validateMirrorsFile(target);
  if (errors.length) {
    console.error(`[validate-mirrors] FAIL: ${label}（${errors.length} 处）`);
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  console.log(`[validate-mirrors] OK: ${label} — ${doc.mirrors.length} 条镜像，updated ${doc.updated}，host 无重复`);
}
