/* 构建：生成 dist/edge、dist/firefox 与 dist/debug，并按目标裁剪 manifest 差异键
 *
 * 正式目标（edge / firefox）会把 lib/debug-log.js 换成 no-op stub，
 * 并移除 options.html 里的调试面板；只有 dist/debug 保留完整调试实现。
 * 这样商店包里不含任何日志采集/导出代码，而 HTML、manifest 与 importScripts
 * 仍引用同一个文件名，不会出现 404。
 * 也可被 tools/ 下的脚本 import，复用图标绘制（此时不执行构建）
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');
const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

const COPY_DIRS = ['lib', 'content', 'options', 'popup', 'verify', 'data', 'icons', '_locales'];
const COPY_FILES = ['background.js'];

// 正式包里的调试模块替身：接口与 lib/debug-log.js 完全一致，但所有方法都是空操作。
// 保留同名文件是为了让三份 HTML、manifest 与 background.js 的 importScripts 引用依旧有效。
const DEBUG_STUB = `/* Production build stub: debug logging is not shipped in store packages.
 * The full implementation is only used by dist/debug (manifest debug:true).
 */
(function (root) {
  'use strict';
  var noop = function () {};
  root.DBG = {
    enabled: false,
    log: noop,
    dump: function () { return Promise.resolve([]); },
    clear: function () { return Promise.resolve(); },
    prune: function () { return Promise.resolve(); },
    text: function () { return Promise.resolve(''); },
    formatLine: function () { return ''; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
`;

/* ------------------------------- PNG 图标 ------------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function makeIcon(size) {
  const S = 3; // 3x3 超采样抗锯齿
  const px = Buffer.alloc(size * size * 4);
  const bg = [31, 111, 235];
  const fg = [255, 255, 255];
  const r = size * 0.22;

  const insideRound = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    const dx = x - cx, dy = y - cy;
    return Math.hypot(dx, dy) <= r + 0.001;
  };

  // 向下箭头 + 底部托盘
  const arrow = (x, y) => {
    const u = x / size, v = y / size;
    if (u > 0.455 && u < 0.545 && v > 0.24 && v < 0.52) return true;
    if (v >= 0.50 && v <= 0.68) {
      const half = 0.20 * (1 - (v - 0.50) / 0.18);
      if (Math.abs(u - 0.5) < half) return true;
    }
    if (v > 0.735 && v < 0.795 && u > 0.31 && u < 0.69) return true;
    return false;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgCov = 0, fgCov = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px_ = x + (sx + 0.5) / S;
          const py_ = y + (sy + 0.5) / S;
          if (insideRound(px_, py_)) {
            bgCov++;
            if (arrow(px_, py_)) fgCov++;
          }
        }
      }
      const total = S * S;
      const a = bgCov / total;
      const f = fgCov / total;
      const i = (y * size + x) * 4;
      if (a === 0) { px[i + 3] = 0; continue; }
      const mix = a > 0 ? f / a : 0;
      px[i] = Math.round(bg[0] * (1 - mix) + fg[0] * mix);
      px[i + 1] = Math.round(bg[1] * (1 - mix) + fg[1] * mix);
      px[i + 2] = Math.round(bg[2] * (1 - mix) + fg[2] * mix);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return encodePNG(size, size, px);
}

/* -------------------------------- 构建 -------------------------------- */

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function buildTarget(name, transformManifest, opts = {}) {
  const out = join(DIST, name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  for (const d of COPY_DIRS) {
    const src = join(ROOT, d);
    if (existsSync(src)) cpSync(src, join(out, d), { recursive: true });
  }
  for (const f of COPY_FILES) cpSync(join(ROOT, f), join(out, f));

  if (opts.production) {
    // 1) 用 no-op stub 覆盖调试模块；2) 从设置页剥掉只有 debug 构建才会显示的面板
    writeFileSync(join(out, 'lib', 'debug-log.js'), DEBUG_STUB, 'utf8');
    const optHtml = join(out, 'options', 'options.html');
    const html = readFileSync(optHtml, 'utf8');
    const stripped = html.replace(
      /<!-- MFL_DEBUG_PANEL_START -->[\s\S]*?<!-- MFL_DEBUG_PANEL_END -->\r?\n?/g, '');
    if (stripped === html) throw new Error(name + ': 未找到调试面板标记，拒绝构建正式包');
    writeFileSync(optHtml, stripped, 'utf8');
  }

  const mf = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  transformManifest(mf);
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(mf, null, 2), 'utf8');

  const files = walk(out);
  return { out, count: files.length };
}

// 源码目录也放一份图标，便于「加载已解压的扩展」直接指向仓库根目录
function writeRootIcons() {
  const rootIcons = join(ROOT, 'icons');
  mkdirSync(rootIcons, { recursive: true });
  for (const s of [16, 32, 48, 128]) writeFileSync(join(rootIcons, `icon${s}.png`), makeIcon(s));
}

function buildAll() {
  writeRootIcons();

  const edge = buildTarget('edge', mf => {
    delete mf.browser_specific_settings;
    // Chrome 在 MV3 下不接受 background.scripts，必须只留 service_worker
    mf.background = { service_worker: mf.background.service_worker };
  }, { production: true });

  const firefox = buildTarget('firefox', mf => {
    delete mf.minimum_chrome_version;
    // Firefox 不支持 background.service_worker
    mf.background = { scripts: mf.background.scripts };
  }, { production: true });

  // 调试构建：与 edge 相同，但带 debug:true（打开日志面板）并改成一眼能认出的名字。
  // 只在本机排查用，不进商店、不进 release。
  const dbg = buildTarget('debug', mf => {
    delete mf.browser_specific_settings;
    mf.background = { service_worker: mf.background.service_worker };
    mf.debug = true;
    mf.name = '镜像快车道 (debug)';
  });

  console.log(`[edge]    ${edge.out}  ${edge.count} 个文件`);
  console.log(`[firefox] ${firefox.out}  ${firefox.count} 个文件`);
  console.log(`[debug]   ${dbg.out}  ${dbg.count} 个文件  （带调试日志，仅本机排查用）`);
}

export { makeIcon, encodePNG };

if (IS_MAIN) buildAll();
