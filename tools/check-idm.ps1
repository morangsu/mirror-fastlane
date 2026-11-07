# 检查 IDM 的钩子配置是否仍然有效
#
# IDM 没有"下载完成后运行程序"，唯一可用的钩子是「病毒检查」：
# 它把处理后的路径写进 HKCU\Software\DownloadManager 的 VScannerProgram / VScannerParameters。
# 这个脚本把那份配置读出来，核对：解释器在不在、脚本在不在、脚本哈希与基线是否一致。
#
# 用法： powershell -NoProfile -File tools\check-idm.ps1
# 退出码：0 正常 / 1 有问题 / 2 没配置

$ErrorActionPreference = 'Stop'

function Say  { param([string]$m) Write-Host $m }
function Ok   { param([string]$m) Write-Host "[OK] $m"   -ForegroundColor Green }
function Bad  { param([string]$m) Write-Host "[X]  $m"   -ForegroundColor Red }
function Warn { param([string]$m) Write-Host "[!]  $m"   -ForegroundColor Yellow }

$key = 'HKCU:\Software\DownloadManager'
if (-not (Test-Path -LiteralPath $key)) { Bad '这台机器没装 IDM（找不到 HKCU\Software\DownloadManager）'; exit 2 }

$props = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
$progRaw = [string]$props.VScannerProgram
$argsRaw = [string]$props.VScannerParameters
$prog = $progRaw.Trim()
$args_ = $argsRaw.Trim()

if (-not $prog -and -not $args_) {
    Warn 'IDM 里还没配置钩子（VScannerProgram / VScannerParameters 都是空的）'
    Say  '   设置路径：选项 → 下载 → 病毒检查设置 → 编辑'
    exit 2
}

Say ''
Say "程序   $prog"
Say "参数   $args_"
Say ''

$fail = 0

# 从聊天窗口/文档粘贴时最常带上的脏东西：尾部换行或空格。
# 程序路径带换行会让 CreateProcess 直接 ENOENT（实测 3 ms 失败），钩子静默不触发。
if ($progRaw -ne $prog -or $argsRaw -ne $args_) {
    $which = @()
    if ($progRaw -ne $prog) { $which += '程序' }
    if ($argsRaw -ne $args_) { $which += '参数' }
    Bad ("$(($which -join ' / ')) 的值尾部有多余空白或换行，IDM 会启动失败；请在 IDM 里重新录入")
    $fail++
}

# 1) 解释器存在
if ($prog -and (Test-Path -LiteralPath $prog)) { Ok "解释器存在" }
else { Bad "解释器路径无效: $prog"; $fail++ }

# 2) 从参数里抠出脚本路径
$scriptPath = ''
$m = [regex]::Match($args_, '-File\s+"([^"]+)"')
if ($m.Success) { $scriptPath = $m.Groups[1].Value } else {
    $m2 = [regex]::Match($args_, '-File\s+(\S+)')
    if ($m2.Success) { $scriptPath = $m2.Groups[1].Value }
}

if (-not $scriptPath) {
    Bad '参数里没有 -File "…hash-hook.ps1"'
    $fail++
} else {
    Say "脚本   $scriptPath"
    if (Test-Path -LiteralPath $scriptPath) { Ok '脚本存在' } else { Bad '脚本不存在（被移动或删除）'; $fail++ }
}

# 3) 脚本哈希与同目录基线
if ($scriptPath -and (Test-Path -LiteralPath $scriptPath)) {
    $dir = Split-Path -Parent $scriptPath
    $sumFile = Join-Path $dir 'hash-hook.sha256'
    if (-not (Test-Path -LiteralPath $sumFile)) {
        Warn '同目录没有 hash-hook.sha256，无法核对基线'
    } else {
        $line = (Get-Content -LiteralPath $sumFile -TotalCount 1).Trim()
        $base = ($line -split '\s+')[0].ToLower()
        $real = (Get-FileHash -LiteralPath $scriptPath -Algorithm SHA256).Hash.ToLower()
        if ($base -eq $real) { Ok "脚本哈希与基线一致（$($real.Substring(0,12))…）" }
        else { Bad "脚本哈希与基线不一致：基线 $($base.Substring(0,12))… / 实际 $($real.Substring(0,12))…"; $fail++ }
    }
}

# 4) 关键参数是否还在
if ($args_ -match '\[File\]') { Ok '参数里保留了 [File] 占位符' }
else { Bad '参数里没有 [File]，IDM 不会把下载文件的路径传进来'; $fail++ }

if ($args_ -match '-WindowStyle\s+Hidden') { Ok '窗口隐藏已设置（不会每次下载弹黑框）' }
else { Warn '没设 -WindowStyle Hidden，下载完成时可能闪一下窗口' }

# 5) 回源凭据状态（只报状态，不算钩子配置错误）
if ($scriptPath -and (Test-Path -LiteralPath $scriptPath)) {
    $auth = Join-Path (Split-Path -Parent $scriptPath) 'auth.txt'
    if (Test-Path -LiteralPath $auth -PathType Leaf) {
        $first = ([System.IO.File]::ReadAllLines($auth, [System.Text.Encoding]::UTF8) |
            Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') } | Select-Object -First 1)
        $fmt = if ($first -and $first.Trim().StartsWith('dpapi:')) { 'DPAPI 密文' } else { '明文' }
        Ok "回源凭据文件存在（$fmt，优先使用）"
    } else {
        Warn '没有回源凭据文件 auth.txt'
    }
    $hits = @()
    foreach ($scope in @('Process', 'User', 'Machine')) {
        try {
            $v = [string][Environment]::GetEnvironmentVariable('GITHUB_TOKEN', $scope)
            if ($v -and $v.Trim()) { $hits += "$scope($($v.Trim().Length) 字符)" }
        } catch { }
    }
    if ($hits.Count) { Ok "GITHUB_TOKEN 已配置：$($hits -join ', ')" }
    else { Warn 'GITHUB_TOKEN 未配置；匿名回源按出口 IP 限 60 次/小时，可能降级为 pass-unverified' }
    if (-not (Test-Path -LiteralPath $auth -PathType Leaf) -and -not $hits.Count) {
        Say '   配置：运行同目录 set-hook-token.cmd，按提示粘贴 PAT 即可自动完成写入与自检'
    }
}

Say ''
if ($fail -eq 0) { Say '结论：IDM 钩子配置有效。' -ForegroundColor Green; exit 0 }
Say '结论：配置有问题，按上面红字修。' -ForegroundColor Red
exit 1
