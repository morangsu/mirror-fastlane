/* 用 Node 起一个子进程运行 PowerShell 测试，避免直接在外层 shell 调 PowerShell */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'test', 'hook-tests.ps1');

const candidates = ['pwsh', 'powershell'];
const bin = candidates.find(b => {
  const r = spawnSync(b, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
  return r.status === 0;
});

if (!bin) {
  console.error('找不到 pwsh 或 powershell');
  process.exit(2);
}

if (!existsSync(SCRIPT)) {
  console.error('找不到测试脚本:', SCRIPT);
  process.exit(2);
}

console.log(`使用解释器: ${bin}`);
// 先切到 UTF-8 输出，否则中文在非中文代码页下会乱码
const r = spawnSync(bin, [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
  `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & '${SCRIPT.replace(/'/g, "''")}'; exit $LASTEXITCODE`,
], {
  encoding: 'utf8',
  cwd: ROOT,
});

if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.status === null ? 1 : r.status);
