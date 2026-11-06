# 哈希校验脚本的完整性自检
#
# 做两件事：
#   1) 拿 hooks\hash-hook.sha256 这份基线，核对 hash-hook.ps1 有没有被改；
#   2) 如果在 git 仓库里，再核对基线本身有没有被一起改掉
#      （只改脚本、顺手把基线也改成新值，是最容易想到的绕过方式）。
#
# 用法：
#   pwsh -NoProfile -File hooks\check-integrity.ps1
#   pwsh -NoProfile -File hooks\check-integrity.ps1 -Update   # 你自己改过脚本后，重建基线
#
# 退出码：0 一致 / 1 不一致 / 2 缺基线或参数不对

[CmdletBinding(PositionalBinding = $false)]
param(
    [switch]$Update,
    [switch]$NoGit,
    [string]$Target = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Target) { $Target = Join-Path $PSScriptRoot 'hash-hook.ps1' }
$sumFile = [System.IO.Path]::ChangeExtension($Target, '.sha256')   # hash-hook.ps1 -> hash-hook.sha256

function Fail { param([string]$m) Write-Host "[X]  $m" -ForegroundColor Red }
function Pass { param([string]$m) Write-Host "[OK] $m" -ForegroundColor Green }
function Warn { param([string]$m) Write-Host "[!]  $m" -ForegroundColor Yellow }

if (-not (Test-Path -LiteralPath $Target)) { Fail "找不到脚本: $Target"; exit 2 }

$leaf = Split-Path -Leaf $Target
$actual = (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLower()

if ($Update) {
    $line = $actual + '  ' + $leaf
    [System.IO.File]::WriteAllText($sumFile, $line + "`n", (New-Object System.Text.UTF8Encoding($false)))
    Pass "基线已更新: $sumFile"
    Write-Host "     SHA-256  $actual"
    Warn '记得把脚本和基线两个文件一起提交，否则下次自检会报「基线未提交」'
    exit 0
}

if (-not (Test-Path -LiteralPath $sumFile)) {
    Fail "没有基线文件: $sumFile"
    Write-Host '     首次使用先运行一次: -Update'
    exit 2
}

# 基线格式与 sha256sum 一致：<hash>  <文件名>
$baseline = ''
foreach ($l in [System.IO.File]::ReadAllLines($sumFile)) {
    $t = $l.Trim()
    if (-not $t) { continue }
    $baseline = ($t -split '\s+')[0].ToLower()
    break
}

if ($baseline -notmatch '^[a-f0-9]{64}$') {
    Fail "基线文件内容不是合法 SHA-256: $sumFile"
    exit 2
}

$hashOk = ($baseline -eq $actual)

# git 侧：基线本身是不是也被改了
$repoRoot = $null
$gitOk = $true
$gitNote = ''

if (-not $NoGit) {
    try {
        $repoRoot = [string](& git -C $PSScriptRoot rev-parse --show-toplevel 2>$null)
        if ($LASTEXITCODE -ne 0) { $repoRoot = $null }
    } catch { $repoRoot = $null }

    if (-not $repoRoot) {
        $gitNote = '不在 git 仓库里，跳过「基线是否已提交」检查'
    } else {
        $repoRoot = $repoRoot.Trim()
        $relScript = 'hooks/' + $leaf
        $relSum = 'hooks/' + (Split-Path -Leaf $sumFile)
        $dirty = @(& git -C $repoRoot status --porcelain -- $relScript $relSum 2>$null |
            Where-Object { $_ -and $_.Trim() })
        if ($dirty.Count -gt 0) {
            $gitOk = $false
            $gitNote = ($dirty -join ' ; ')
        }
    }
}

Write-Host ''
Write-Host "脚本     $Target"
Write-Host "基线     $sumFile"
Write-Host "SHA-256  $actual"
Write-Host ''

if ($hashOk) { Pass '脚本内容与基线一致' }
else { Fail '脚本内容与基线不一致，可能被改动过' }

if (-not $repoRoot) { Warn $gitNote }
elseif ($gitOk) { Pass '基线已提交，工作区干净' }
else { Fail "脚本或基线有未提交的改动: $gitNote" }

Write-Host ''
if ($hashOk -and $gitOk) {
    Write-Host '结论：当前脚本可信。' -ForegroundColor Green
    exit 0
}

Warn '改动如果是你自己做的，用 -Update 重建基线并提交；否则请从仓库重新取回脚本。'
exit 1
