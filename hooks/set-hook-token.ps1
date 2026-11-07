# 把 GitHub PAT 写进 hash-hook.ps1 的凭据文件（回源复核用）
#
# 最常用：不带任何参数直接运行 —— 先提示粘贴 PAT（不回显），随后自动跑完剩余步骤：
#   写入加密凭据 → 收紧 ACL → 用 IDM 同款 5.1 解密自检 → 联网验证 GitHub API 认证 → 输出状态
#
# 本工具可以从任意目录运行（下载文件夹 / U 盘 / 临时目录都行）：
#   凭据位置以 IDM 注册表里实际挂载的 hash-hook.ps1 所在目录为准，
#   因为 hash-hook.ps1 只读「自己同目录的 auth.txt」。未挂载 IDM 时退回到本脚本同目录。
#
# 用法（推荐同目录的 set-hook-token.cmd，CMD / PowerShell 都能直接跑，不用记变量语法）：
#   set-hook-token.cmd                                 # 交互输入 PAT，然后自动完成全部步骤
#   set-hook-token.cmd -FromClipboard                  # 从剪贴板取 PAT，其余相同
#   set-hook-token.cmd -NoVerify                      # 交互输入，但跳过联网自检
#   set-hook-token.cmd -Show                          # 只看状态，不显示 token
#   set-hook-token.cmd -Remove                        # 删掉凭据文件，退回环境变量
#
# 直接用 .ps1 时，PowerShell 里路径变量要写 $env:LOCALAPPDATA，CMD 里才是 %LOCALAPPDATA%：
#   powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\MirrorFastlane\set-hook-token.ps1"   # PowerShell
#   powershell -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\MirrorFastlane\set-hook-token.ps1"     # CMD
#
# 默认写 DPAPI(CurrentUser) 密文，只有当前 Windows 用户能解密；-PlainText 才写明文。
# 文件 ACL 会收紧为「当前用户 + SYSTEM + Administrators」，去掉继承来的宽松规则。
# 注意：DPAPI 密文绑定当前用户，换用户 / 重装系统后需要重新运行本脚本。
# token 只进 Authorization 头，绝不写日志、outbox.txt、通知或子进程命令行。

[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$Token = '',
    [switch]$FromClipboard,
    [switch]$PlainText,
    [switch]$Remove,
    [switch]$Show,
    [switch]$NoVerify,
    [string]$TokenFile = ''
)

$ErrorActionPreference = 'Stop'

function Say  { param([string]$m) Write-Host $m }
function Ok   { param([string]$m) Write-Host "[OK] $m" -ForegroundColor Green }
function Bad  { param([string]$m) Write-Host "[X]  $m" -ForegroundColor Red }
function Warn { param([string]$m) Write-Host "[!]  $m" -ForegroundColor Yellow }

function Get-IdmHookPath {
    # IDM「病毒检查」把真正被调用的脚本写在 HKCU\Software\DownloadManager\VScannerParameters。
    # 这是唯一权威来源：本工具本身可能躺在下载文件夹、U 盘或任意临时目录里。
    # hash-hook.ps1 读的是「自己同目录的 auth.txt」，所以凭据必须写到那个目录。
    try {
        $key = 'HKCU:\Software\DownloadManager'
        if (-not (Test-Path -LiteralPath $key)) { return '' }
        $p = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
        $raw = ([string]$p.VScannerParameters).Trim()
        if (-not $raw) { return '' }
        $hits = @()
        foreach ($re in @('(?i)-File\s+"([^"]+\.ps1)"', '(?i)-File\s+([^\s"]+\.ps1)')) {
            foreach ($m in [regex]::Matches($raw, $re)) { $hits += $m.Groups[1].Value.Trim() }
        }
        foreach ($h in $hits) {
            if (Test-Path -LiteralPath $h -PathType Leaf) { return $h }
        }
        # 参数里写了但文件不存在（脚本被移走/删除），也要带回去提示
        if ($hits.Count) { return $hits[0] }
    } catch { }
    return ''
}

$idmHook      = Get-IdmHookPath
$deployScript = Join-Path $env:LOCALAPPDATA 'MirrorFastlane\hash-hook.ps1'
$localHook    = Join-Path $PSScriptRoot 'hash-hook.ps1'
$mismatch     = $false

# 决策顺序：IDM 实际挂载的 hook > 默认部署目录 > 本脚本所在目录（便携模式）
if ($idmHook -and (Test-Path -LiteralPath $idmHook -PathType Leaf)) {
    $authDir  = Split-Path -Parent $idmHook
    $source   = 'IDM 注册表里挂载的 hash-hook.ps1 所在目录'
    $hookPath = $idmHook
} elseif (Test-Path -LiteralPath $deployScript -PathType Leaf) {
    $authDir  = Split-Path -Parent $deployScript
    $source   = '默认部署目录 %LOCALAPPDATA%\MirrorFastlane'
    $hookPath = $deployScript
} else {
    $authDir  = $PSScriptRoot
    $source   = '本脚本当前所在目录（便携模式）'
    $hookPath = if (Test-Path -LiteralPath $localHook -PathType Leaf) { $localHook } else { '' }
}

if (-not $TokenFile) {
    $TokenFile = Join-Path $authDir 'auth.txt'
} elseif ($hookPath -and ((Split-Path -Parent $TokenFile) -ne (Split-Path -Parent $hookPath))) {
    $mismatch = $true
}
if (-not $hookPath) { $hookPath = Join-Path (Split-Path -Parent $TokenFile) 'hash-hook.ps1' }
if (-not (Test-Path -LiteralPath $hookPath -PathType Leaf)) { $hookPath = $localHook }

function Get-EnvTokenInfo {
    param([string]$Name = 'GITHUB_TOKEN')
    $hits = @()
    foreach ($scope in @('Process', 'User', 'Machine')) {
        try {
            $v = [string][Environment]::GetEnvironmentVariable($Name, $scope)
            if ($v -and $v.Trim()) { $hits += "$scope($($v.Trim().Length) 字符)" }
        } catch { }
    }
    if ($hits.Count) { return ($hits -join ', ') }
    return '未配置'
}

function Protect-FileAcl {
    param([string]$Path)
    try {
        $acl = Get-Acl -LiteralPath $Path
        $acl.SetAccessRuleProtection($true, $false)   # 断开继承并移除继承来的规则
        $sidMe  = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $sidSys = [System.Security.Principal.SecurityIdentifier]::new(
            [System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
        $sidAdm = [System.Security.Principal.SecurityIdentifier]::new(
            [System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
        foreach ($sid in @($sidMe, $sidSys, $sidAdm)) {
            $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
                $sid, 'FullControl', 'Allow')
            $acl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $Path -AclObject $acl
        return $true
    } catch {
        return $false
    }
}

function Test-TokenShape {
    param([string]$T)
    $T = ([string]$T).Trim()
    return ($T.Length -ge 8 -and $T.Length -le 512 -and $T -notmatch '\s')
}

# 交互式输入：允许 3 次重试，空输入视为取消；返回 $null = 失败，'' = 取消
function Read-TokenInteractive {
    # stdin 被重定向（管道 / CI / 自动化）时，5.1 的 Read-Host -AsSecureString 会永久等待。
    # 这时直接读一行，让「输入 PAT → 自动跑完剩余步骤」在非交互环境也能完成。
    if ([Console]::IsInputRedirected) {
        $piped = ''
        try { $piped = [string][Console]::In.ReadLine() } catch { }
        $piped = ([string]$piped).Trim()
        if (-not $piped) {
            Bad 'stdin 已重定向但没读到 PAT；请在真实终端窗口运行，或改用 -FromClipboard / -Token'
            return $null
        }
        if (-not (Test-TokenShape $piped)) {
            Bad '从 stdin 读到的 PAT 格式不合法'
            return $null
        }
        Warn 'PAT 来自重定向的 stdin（管道 / 自动化），可能留在上游调用方的日志里'
        return $piped
    }
    for ($i = 1; $i -le 3; $i++) {
        try {
            $sec = Read-Host '粘贴 GitHub token 后按回车（输入不回显；直接回车 = 取消）' -AsSecureString
            $t = ([string][System.Net.NetworkCredential]::new('', $sec).Password).Trim()
        } catch {
            Bad ('读取输入失败：' + $_.Exception.Message)
            return $null
        }
        if (-not $t) { Warn '已取消，未写入任何文件'; return '' }
        if (-not (Test-TokenShape $t)) {
            Warn ("格式不合法（长度 $($t.Length)，需 8~512 且不含空白）；还可重试 $(3 - $i) 次")
            continue
        }
        return $t
    }
    Bad '连续 3 次输入不合法，已取消'
    return $null
}

# 写入后的自检：起一个 powershell.exe 5.1 子进程（与 IDM 调用环境一致），
# 让它自己从凭据文件读 token —— 命令行里绝不出现 token。
function Invoke-CredentialSelfCheck {
    param([string]$Path, [string]$HookPath, [switch]$SkipNet)

    Say ''
    Say '[3/3] 自检（IDM 同款 powershell.exe 5.1 读回凭据并复核 GitHub API）'

    $probe = @'
param([string]$TokenFile, [string]$HookPath, [switch]$SkipNet)
$ErrorActionPreference = 'Stop'
# The dot-sourced hook also has param($TokenFile) and would reset ours to empty.
# Keep ASCII-only here: this probe is read by Windows PowerShell 5.1.
$credPath = $TokenFile
$hookFile = $HookPath
. $hookFile -Lib -NoNet -Quiet
$tok = Read-TokenFile -Path $credPath
if (-not $tok -or -not ([string]$tok).Trim()) {
    'DECRYPT=FAIL'
    'DIAG:credPath=[' + $credPath + ']'
    'DIAG:paramTokenFile=[' + $TokenFile + ']'
    'DIAG:exists=' + (Test-Path -LiteralPath $credPath -PathType Leaf)
    'DIAG:hookFile=[' + $hookFile + ']'
    if (Test-Path -LiteralPath $credPath -PathType Leaf) {
        $raw = [System.IO.File]::ReadAllText($credPath, [System.Text.Encoding]::UTF8)
        'DIAG:rawlen=' + $raw.Length
        $one = @($raw -split "`r?`n" | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') } | Select-Object -First 1)
        if ($one.Count) { 'DIAG:prefix=' + $one[0].Substring(0, [Math]::Min(14, $one[0].Length)) }
    }
    exit 1
}
'DECRYPT=OK;LEN=' + ([string]$tok).Trim().Length
$defTok = if ($script:DefaultTokenFile) { $script:DefaultTokenFile } else { Join-Path (Split-Path -Parent $hookFile) 'auth.txt' }
'HOOKDEFAULT=' + $defTok
if ($SkipNet) { 'NET=SKIP'; exit 0 }
$h = @{
    'Accept'        = 'application/vnd.github+json'
    'User-Agent'    = 'mfl-hash-hook'
    'Authorization' = 'Bearer ' + ([string]$tok).Trim()
}
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $r = Invoke-WebRequest -Uri 'https://api.github.com/rate_limit' `
        -Headers $h -UseBasicParsing -TimeoutSec 12
    'NET=OK;HTTP=' + [int]$r.StatusCode `
        + ';LIMIT=' + $r.Headers['X-RateLimit-Limit'] `
        + ';REMAINING=' + $r.Headers['X-RateLimit-Remaining']
} catch {
    $e = $_.Exception
    $code = 0
    try { if ($e.Response) { $code = [int]$e.Response.StatusCode } } catch { }
    'NET=ERR;CODE=' + $code + ';MSG=' + (($e.Message -replace '[\r\n;]', ' ').Trim())
}
exit 0
'@

    $tmp = Join-Path $env:TEMP ('mfl-verify-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.ps1')
    try {
        # 5.1 reads BOM-less UTF-8 as ANSI; keep the probe ASCII-only and still add a BOM
        [System.IO.File]::WriteAllText($tmp, $probe, (New-Object System.Text.UTF8Encoding($true)))
        $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $tmp,
                  '-TokenFile', $Path, '-HookPath', $HookPath)
        if ($SkipNet) { $argv += '-SkipNet' }

        $old = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { $lines = @(& powershell.exe @argv 2>&1 | ForEach-Object { [string]$_ }) }
        finally { $ErrorActionPreference = $old }

        $dec = @($lines | Where-Object { $_ -like 'DECRYPT=*' } | Select-Object -First 1)
        $net = @($lines | Where-Object { $_ -like 'NET=*' } | Select-Object -First 1)
        $def = @($lines | Where-Object { $_ -like 'HOOKDEFAULT=*' } | Select-Object -First 1)
        if (-not $dec.Count -or $dec[0] -eq 'DECRYPT=FAIL') {
            Bad '5.1 子进程解密失败（DPAPI 绑定用户不匹配或凭据文件损坏）'
            Say ('  子进程参数：' + ($argv -join ' | '))
            try { Say ('  probe 首行：' + ([System.IO.File]::ReadAllLines($tmp)[0])) } catch { }
            $tail = @($lines | Select-Object -First 12)
            if ($tail.Count) {
                Say '  子进程原始输出：'
                foreach ($l in $tail) { Say ('    ' + $l) }
            } else {
                Say '  子进程没有任何输出（可能启动失败或 dot-source 报错）'
            }
            return
        }
        Ok ('5.1 解密成功（' + ($dec[0] -replace '^DECRYPT=OK;LEN=', '') + ' 字符），与 IDM 调用环境一致')

        if ($def.Count) {
            $defPath = $def[0] -replace '^HOOKDEFAULT=', ''
            if ($defPath -eq $Path) {
                Ok 'IDM 调用 hook 时会在默认路径读到这份凭据（目录一致）'
            } else {
                Warn "目录不一致：IDM hook 默认读 $defPath"
                Warn "本次写入的是 $Path —— 回源可能读不到，请把 auth.txt 放到 hook 同目录或重跑本工具（不带 -TokenFile）"
            }
        }

        if (-not $net.Count -or $net[0] -eq 'NET=SKIP') {
            Say '联网自检已跳过（-NoVerify）；凭据已写入，下一次下载回调即生效'
            return
        }
        if ($net[0] -like 'NET=OK;*') {
            $parts = @{}
            foreach ($seg in ($net[0] -split ';')) {
                if ($seg -match '^([A-Z]+)=(.*)$') { $parts[$Matches[1]] = $Matches[2] }
            }
            Ok ("GitHub API 认证生效：HTTP $($parts['HTTP'])，限额 $($parts['LIMIT']) 次/小时，剩余 $($parts['REMAINING'])")
            if ([int]$parts['LIMIT'] -ge 5000) {
                Say '已按 token 计费，不会再撞匿名 60 次/小时；回源可恢复到 pass'
            } else {
                Warn '限额看起来仍是匿名档，请检查 token 是否被 GitHub 接受'
            }
            return
        }

        $seg2 = @{}
        foreach ($seg in ($net[0] -split ';')) {
            if ($seg -match '^([A-Z]+)=(.*)$') { $seg2[$Matches[1]] = $Matches[2] }
        }
        $code2 = [int]$seg2['CODE']
        if ($code2 -eq 401) {
            Bad 'GitHub API 返回 401：token 无效或已撤销，请重新生成后重跑本向导'
        } elseif ($code2 -eq 403 -or $code2 -eq 429) {
            Warn "GitHub API 返回 $code2：限流或权限不足；凭据已写入，稍后可重试"
        } else {
            Warn ("联网自检未完成（$($seg2['MSG'])）；凭据已写入，不影响下次下载回源")
        }
    } finally {
        if (Test-Path -LiteralPath $tmp) { [System.IO.File]::Delete($tmp) }
    }
}

$idmShown = if ($idmHook) { $idmHook } else { '未检测到（IDM 未挂载 / 脚本已移动）' }
Say 'mirror-fastlane 回源凭据配置'
Say "本脚本      $PSCommandPath"
Say "IDM 挂载    $idmShown"
Say "凭据目录    $source"
Say "凭据文件    $TokenFile"
Say "自检 hook   $hookPath"
if ($source -like '*便携模式*') {
    Warn '未检测到 IDM 挂载的 hook，凭据只会写到本脚本同目录（从 GitHub 下载后直接运行的常见情形）'
    Say  '   把 hash-hook.ps1 挂到 IDM 后请重新运行本工具，或把 auth.txt 复制到 IDM 实际调用的脚本同目录'
}
if ($mismatch) {
    Warn '你用 -TokenFile 指定的位置与 IDM hook 目录不同，回源可能读不到该凭据'
}

if ($Show) {
    $hasFile = Test-Path -LiteralPath $TokenFile -PathType Leaf
    if ($hasFile) {
        $head = ([System.IO.File]::ReadAllText($TokenFile, [System.Text.Encoding]::UTF8) -split "`r?`n" |
            Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') } | Select-Object -First 1)
        $fmt = if ($head -and $head.Trim().StartsWith('dpapi:')) { 'DPAPI(CurrentUser) 密文' } else { '明文' }
        Ok "凭据文件存在（$fmt）"
    } else {
        Warn '凭据文件不存在'
    }
    $envInfo = Get-EnvTokenInfo
    Say "环境变量 GITHUB_TOKEN：$envInfo"
    if (-not $hasFile -and $envInfo -eq '未配置') {
        Warn '当前没有任何凭据来源：回源将以匿名方式请求 GitHub API，可能遇到 403 限流（pass-unverified）'
        Say '配置方式：直接运行 set-hook-token.cmd，按提示粘贴 PAT 即可（会自动完成剩余步骤）'
    }
    Say '提示：hash-hook.ps1 的优先级是 凭据文件 > 环境变量（进程/用户/系统）'
    exit 0
}

if ($Remove) {
    if (Test-Path -LiteralPath $TokenFile -PathType Leaf) {
        [System.IO.File]::Delete($TokenFile)
        Ok '凭据文件已删除，之后回源会退回环境变量 / 匿名'
    } else {
        Warn '凭据文件本来就不存在'
    }
    exit 0
}

# ------------------------------ [1/3] 取得 token ------------------------------
Say ''
Say '[1/3] 输入 PAT'
if ($Token) {
    Warn '注意：-Token 会留在命令行历史和进程命令行里，建议改用交互输入或 -FromClipboard'
} elseif ($FromClipboard) {
    try { $Token = [string](Get-Clipboard -Raw) } catch { $Token = '' }
    if (-not $Token.Trim()) { Bad '剪贴板为空或读取失败'; exit 2 }
} else {
    $t = Read-TokenInteractive
    if ($null -eq $t) { exit 2 }
    if ($t -eq '') { exit 0 }
    $Token = $t
}

$Token = ([string]$Token).Trim()
if (-not (Test-TokenShape $Token)) {
    Bad 'token 格式不合法（应为一整串、8~512 字符、不含空白）'
    exit 2
}
Ok "已读取 PAT（$($Token.Length) 字符）；不回显、不写日志、不进子进程命令行"

# ------------------------------ [2/3] 生成内容 ------------------------------
Say ''
Say '[2/3] 写入凭据文件'
$format = 'DPAPI(CurrentUser)'
if ($PlainText) {
    $content = $Token
    $format = '明文'
} else {
    try {
        Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue
        if (-not ('System.Security.Cryptography.ProtectedData' -as [type])) {
            Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop
        }
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Token)
        $enc = [System.Security.Cryptography.ProtectedData]::Protect(
            $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        $content = 'dpapi:' + [Convert]::ToBase64String($enc)
    } catch {
        Bad ('DPAPI 加密失败：' + $_.Exception.Message + '；可加 -PlainText 写明文')
        exit 2
    }
}

$dir = Split-Path -Parent $TokenFile
if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}
[System.IO.File]::WriteAllText($TokenFile,
    '# mirror-fastlane 回源凭据；由 set-hook-token.ps1 生成' + "`n" + $content + "`n",
    (New-Object System.Text.UTF8Encoding($false)))

if (Protect-FileAcl -Path $TokenFile) { Ok 'ACL 已收紧为：当前用户 + SYSTEM + Administrators' }
else { Warn 'ACL 收紧失败，请手动检查该文件权限（脚本仍可读取）' }
Ok "已写入（$format，$($Token.Length) 字符）"

# ------------------------------ [3/3] 自检 ------------------------------
Invoke-CredentialSelfCheck -Path $TokenFile -HookPath $hookPath -SkipNet:$NoVerify

# ------------------------------ 状态回执 ------------------------------
Say ''
Say '--- 完成 ---'
Say "环境变量 GITHUB_TOKEN：$(Get-EnvTokenInfo)"
Say '优先级：本凭据文件 > 环境变量。用 -Show 复查，用 -Remove 删除。'
if ($mismatch) { Warn '本次写入位置与 IDM hook 目录不一致；建议不带 -TokenFile 重跑一次，否则回源可能仍读不到' }
Say '无需重启 IDM，下一次下载回调即生效。'
Say ('想立刻验证整条链路：powershell -NoProfile -ExecutionPolicy Bypass -File "' + $hookPath + '" "<下载文件路径>"')
exit 0
