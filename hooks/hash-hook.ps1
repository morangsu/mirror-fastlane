# 哈希校验与通知脚本（可选增强，不随扩展打包）
#
# 用途：下载器完成时运行本脚本。
#   1) 若扩展写下了任务文件（_mfl-tasks\*.task.json，含期望哈希），按文件名找到下载文件，
#      计算 SHA-256 并比对，结果弹系统通知；
#      默认还会拿任务里的 repo / tag / assetId 回源 api.github.com 复核这条哈希
#      （任务文件是磁盘上的普通 JSON，本地进程可改，单靠它不足以取信），
#      两边不一致就报"哈希来源被改动"，而不是悄悄通过；
#   2) 没有任务文件时默认什么都不做——下载器对每次完成都会调用本脚本，
#      其中大部分是非 GitHub 的下载，不应该弹通知、也不该写记录。
#      想"只算一下最新下载文件的哈希"时加 -ScanRecent。
#
# 下载目录可以自动探测（Chrome / Edge / Brave / Firefox / IDM / 系统下载文件夹），
# 也可用 -DownloadDir 显式指定；下载文件允许位于下载目录的子文件夹（IDM 分类存放）。
#
# 用法示例：
#   IDM：选项 → 下载完成后运行程序
#        pwsh -NoProfile -ExecutionPolicy Bypass -File "C:\path\hash-hook.ps1"
#   IDM 失败回调：同上，末尾加 -Status fail
#   aria2：--on-download-complete="C:\path\hash-hook.ps1"（会把文件路径作为参数传入）
#
# 安全提示：
#   本脚本只做四件事：读本地文件、计算 SHA-256、写一行文本 / 弹一条通知、
#   以及在需要时向 api.github.com 发一个只读 GET 请求复核哈希来源。
#   不发任何本地内容，不上传文件，不执行下载内容，不跟随任务文件里的任意域名。
#   回源地址写死为 https://api.github.com，可用 -NoNet 完全关闭联网。
#   请自行审查后再使用。

[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Position = 0)]
    [string]$Arg0,

    [Parameter(Position = 1)]
    [string]$Arg1,

    [Parameter(Position = 2)]
    [string]$Arg2,

    [string]$Outbox = '',
    [string]$DownloadDir = '',
    [string]$TaskDir = '',
    [ValidateSet('auto', 'ok', 'fail')]
    [string]$Status = 'auto',
    [switch]$NoNotify,
    [switch]$Quiet,
    [switch]$NoNet,
    [switch]$Lib,
    [switch]$ScanRecent,
    [int]$NetTimeoutSec = 8,
    [int]$KeepDays = 7,
    [int]$MaxLines = 200
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$MaxWaitSeconds = 30
$RecentMinutes = 30
$TempExt = @('.tmp', '.part', '.partial', '.dwl', '.dwl2', '.aria2', '.!ut', '.crdownload', '.opdownload')
$TaskFolderName = '_mfl-tasks'

#region 通用工具

function Read-TextShared {
    # 浏览器运行时 Preferences / prefs.js 常被独占，需要共享读
    param([string]$FileFullPath)
    if (-not (Test-Path -LiteralPath $FileFullPath)) { return $null }
    try {
        $fs = [System.IO.File]::Open($FileFullPath, [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8, $true)
            $text = $sr.ReadToEnd()
            $sr.Dispose()
            return $text
        } finally { $fs.Dispose() }
    } catch { return $null }
}

function Write-Log {
    param([string]$Message)
    if ($Quiet) { return }
    Write-Host "[mfl] $Message"
}

function Test-IsDir {
    param([string]$DirPath)
    if (-not $DirPath) { return $false }
    try { return [System.IO.Directory]::Exists($DirPath) } catch { return $false }
}

#endregion

#region 下载目录探测

function Get-ChromiumDownloadDirs {
    param([System.Collections.Generic.List[string]]$Into)

    $roots = @(
        @{ Name = 'Chrome';   Path = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data' },
        @{ Name = 'Edge';     Path = Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data' },
        @{ Name = 'Brave';    Path = Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\User Data' },
        @{ Name = 'Chromium'; Path = Join-Path $env:LOCALAPPDATA 'Chromium\User Data' },
        @{ Name = 'Vivaldi';  Path = Join-Path $env:LOCALAPPDATA 'Vivaldi\User Data' }
    )

    foreach ($r in $roots) {
        if (-not (Test-IsDir $r.Path)) { continue }
        $profiles = Get-ChildItem -LiteralPath $r.Path -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq 'Default' -or $_.Name -match '^Profile \d+$' }

        foreach ($p in $profiles) {
            $raw = Read-TextShared (Join-Path $p.FullName 'Preferences')
            if (-not $raw) { continue }

            # 只截取 download.default_directory，避免解析整份大 JSON
            $m = [regex]::Match($raw, '"download"\s*:\s*\{[^{}]*?"default_directory"\s*:\s*"((?:[^"\\]|\\.)*)"')
            if (-not $m.Success) { continue }

            $dir = $m.Groups[1].Value -replace '\\\\', '\' -replace '\\"', '"'
            if ($dir -and (Test-IsDir $dir)) {
                if (-not $Into.Contains($dir)) { $Into.Add($dir) }
                Write-Log "$($r.Name)/$($p.Name) 的下载目录: $dir"
            }
        }
    }
}

function Get-FirefoxDownloadDirs {
    param([System.Collections.Generic.List[string]]$Into)

    $profileRoots = @(
        (Join-Path $env:APPDATA 'Mozilla\Firefox\Profiles'),
        (Join-Path $env:LOCALAPPDATA 'Mozilla\Firefox\Profiles')
    )

    foreach ($root in $profileRoots) {
        if (-not (Test-IsDir $root)) { continue }
        foreach ($p in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
            $raw = Read-TextShared (Join-Path $p.FullName 'prefs.js')
            if (-not $raw) { continue }

            # folderList: 0=桌面 1=下载 2=自定义
            $fl = [regex]::Match($raw, 'user_pref\("browser\.download\.folderList",\s*(\d+)\)')
            $dr = [regex]::Match($raw, 'user_pref\("browser\.download\.dir",\s*"((?:[^"\\]|\\.)*)"\)')

            if ($fl.Success -and $fl.Groups[1].Value -eq '2' -and $dr.Success) {
                $d = $dr.Groups[1].Value -replace '\\\\', '\'
                if (Test-IsDir $d -and -not $Into.Contains($d)) {
                    $Into.Add($d)
                    Write-Log "Firefox 的下载目录: $d"
                }
            }
        }
    }
}

function Get-IdmDownloadDir {
    # IDM 默认目录存在 LocalPathW，是 UTF-16 的字节数组
    foreach ($key in 'HKCU:\Software\DownloadManager', 'HKLM:\SOFTWARE\WOW6432Node\DownloadManager') {
        if (-not (Test-Path -LiteralPath $key)) { continue }
        $props = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
        if (-not $props) { continue }
        foreach ($name in 'LocalPathW', 'LocalPath') {
            if ($props.PSObject.Properties.Name -notcontains $name) { continue }
            $val = $props.$name
            if ($val -is [byte[]]) {
                $s = -join ($val | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ })
                if ($s) { return $s }
            } elseif ($val) {
                return [string]$val
            }
        }
    }
    return $null
}

function Get-ShellDownloadDir {
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
    $guid = '{374DE290-123F-4565-9164-39C4925E467B}'
    if (Test-Path -LiteralPath $key) {
        $p = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
        if ($p -and $p.PSObject.Properties.Name -contains $guid) {
            $v = [Environment]::ExpandEnvironmentVariables([string]$p.$guid)
            if (Test-IsDir $v) { return $v }
        }
    }
    $fallback = Join-Path $env:USERPROFILE 'Downloads'
    if (Test-IsDir $fallback) { return $fallback }
    return $null
}

function Resolve-RealPath {
    # 已知文件夹常被重定向成符号链接（如 Downloads -> D:\Downloads），需要还原成真实路径
    param([string]$DirPath)
    try {
        $item = Get-Item -LiteralPath $DirPath -Force -ErrorAction Stop
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            $target = $item.Target
            if ($target) {
                if ([System.IO.Path]::IsPathRooted($target)) {
                    return [System.IO.Path]::GetFullPath($target)
                }
                return [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $DirPath) $target))
            }
        }
        return $DirPath
    } catch { return $DirPath }
}

function Resolve-DownloadDirs {
    # 显式参数优先；否则自动探测。返回去重后的候选目录列表。
    $list = New-Object System.Collections.Generic.List[string]

    if ($DownloadDir) {
        foreach ($d in ($DownloadDir -split '[,;]')) {
            $d = $d.Trim().Trim('"')
            if (-not $d) { continue }
            if (Test-IsDir $d) {
                if (-not $list.Contains($d)) { $list.Add($d) }
            } else {
                Write-Log "跳过不存在的目录: $d"
            }
        }
        if ($list.Count -gt 0) { return $list }
    }

    Write-Log '未指定下载目录，自动探测…'
    Get-ChromiumDownloadDirs -Into $list
    Get-FirefoxDownloadDirs -Into $list

    $idm = Get-IdmDownloadDir
    if ($idm -and (Test-IsDir $idm) -and -not $list.Contains($idm)) {
        $list.Add($idm)
        Write-Log "IDM 默认目录: $idm"
    }

    $shell = Get-ShellDownloadDir
    if ($shell -and -not $list.Contains($shell)) {
        $list.Add($shell)
        Write-Log "系统下载文件夹: $shell"
    }

    # 解析符号链接并去重：Downloads 常被重定向到其他盘，与浏览器配置指向同一处
    $real = New-Object System.Collections.Generic.List[string]
    foreach ($d in $list) {
        $r = Resolve-RealPath $d
        if (-not $real.Contains($r)) { $real.Add($r) }
    }
    return $real
}

#endregion

#region 任务文件

function Get-TaskFiles {
    param([System.Collections.Generic.List[string]]$Dirs)

    $files = New-Object System.Collections.Generic.List[object]
    $seen = @{}

    $scan = @()
    foreach ($d in $Dirs) { $scan += (Join-Path $d $TaskFolderName) }
    if ($TaskDir) { $scan += $TaskDir }

    foreach ($td in $scan) {
        if (-not (Test-IsDir $td)) { continue }
        foreach ($f in (Get-ChildItem -LiteralPath $td -Filter '*.task.json' -File -ErrorAction SilentlyContinue)) {
            if ($seen.ContainsKey($f.FullName)) { continue }
            $seen[$f.FullName] = $true
            $root = Split-Path -Parent $td
            $files.Add([pscustomobject]@{ File = $f; Root = $root })
        }
    }
    return $files
}

function Read-TaskFile {
    param([string]$TaskPath)
    try {
        $raw = Read-TextShared $TaskPath
        if (-not $raw) { return $null }
        return $raw | ConvertFrom-Json
    } catch { return $null }
}

function Remove-TaskFile {
    param([string]$TaskPath)
    try { Remove-Item -LiteralPath $TaskPath -Force -ErrorAction Stop } catch { }
}

#endregion

#region 文件查找

function Find-FileByName {
    # 按文件名在若干目录里递归查找（IDM 分类子文件夹也能覆盖）
    param([string[]]$Dirs, [string]$Name)

    $pattern = [System.Management.Automation.WildcardPattern]::Escape($Name)

    foreach ($dir in $Dirs) {
        if (-not (Test-IsDir $dir)) { continue }
        $hit = Get-ChildItem -LiteralPath $dir -Recurse -File -Filter $pattern -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notmatch "\\$([regex]::Escape($TaskFolderName))\\" } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if ($hit) { return $hit }
    }
    return $null
}

function Find-DownloadedFile {
    <#
        找某个任务对应的下载文件，能处理重复下载的两种情况：
          · 覆盖同名文件        → 原文件名，但修改时间更新
          · 下载器自动重命名    → "名字 (1).扩展名"、"名字 (2).扩展名" …（IDM 就是这种）
        判据：文件名匹配（含副本编号）且修改时间不早于任务创建时间。
    #>
    param([string[]]$Dirs, [string]$Name, [long]$TaskTs)

    $base = [System.IO.Path]::GetFileNameWithoutExtension($Name)
    $ext = [System.IO.Path]::GetExtension($Name)
    if (-not $base) { return $null }

    # 名字 (1).zip / 名字 (2).zip / 名字.zip
    $strict = '^' + [regex]::Escape($base) + ' \(\d+\)' + [regex]::Escape($ext) + '$'
    $exact = [System.Management.Automation.WildcardPattern]::Escape($Name)

    # 任务时间往前放 5 秒，容忍文件系统时间戳精度
    $after = [datetime]::MinValue
    if ($TaskTs -gt 0) {
        try {
            $after = [DateTimeOffset]::FromUnixTimeMilliseconds($TaskTs).LocalDateTime.AddSeconds(-5)
        } catch { $after = [datetime]::MinValue }
    }

    $best = $null
    foreach ($dir in $Dirs) {
        if (-not (Test-IsDir $dir)) { continue }

        # 先用通配符把候选缩到很小，再逐个精确判断，避免全目录正则扫描
        $candidates = @()
        $candidates += Get-ChildItem -LiteralPath $dir -Recurse -File -Filter $exact -ErrorAction SilentlyContinue
        $candidates += Get-ChildItem -LiteralPath $dir -Recurse -File -Filter "$base (*)$ext" -ErrorAction SilentlyContinue

        foreach ($f in $candidates) {
            if ($f.FullName -match "\\$([regex]::Escape($TaskFolderName))\\") { continue }
            if ($TempExt -contains $f.Extension.ToLower()) { continue }
            if ($f.Length -le 0) { continue }

            $isExact = ($f.Name -eq $Name)
            $isCopy = [regex]::IsMatch($f.Name, $strict)
            if (-not ($isExact -or $isCopy)) { continue }

            if ($after -ne [datetime]::MinValue -and $f.LastWriteTime -lt $after) { continue }

            if (-not $best -or $f.LastWriteTime -gt $best.LastWriteTime) { $best = $f }
        }
    }
    return $best
}

function Clear-StaleTasks {
    # 用户取消下载、或没挂脚本时，任务文件会滞留；超过保留期就清掉
    param([System.Collections.Generic.List[string]]$Dirs, [int]$Days = 7)

    $cut = (Get-Date).AddDays(-$Days)
    $removed = 0
    foreach ($d in $Dirs) {
        $td = Join-Path $d $TaskFolderName
        if (-not (Test-IsDir $td)) { continue }
        Get-ChildItem -LiteralPath $td -Filter '*.task.json' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -lt $cut } |
            ForEach-Object {
                try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop; $removed++ } catch { }
            }
    }
    if ($removed -gt 0) { Write-Log "清理了 $removed 个过期任务文件" }
}

function Find-NewestFile {
    param([string[]]$Dirs, [datetime]$After)

    $best = $null
    foreach ($dir in $Dirs) {
        if (-not (Test-IsDir $dir)) { continue }
        $f = Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object {
                $_.LastWriteTime -gt $After -and
                $_.FullName -notmatch "\\$([regex]::Escape($TaskFolderName))\\" -and
                $_.Name -notlike 'outbox*.txt' -and
                ($TempExt -notcontains $_.Extension.ToLower()) -and
                $_.Length -gt 0
            } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if ($f -and (-not $best -or $f.LastWriteTime -gt $best.LastWriteTime)) { $best = $f }
    }
    return $best
}

#endregion

#region 通知

function Show-ResultNotify {
    # 依次尝试三种后端，任一成功即可，全都失败则静默（不阻塞下载器）
    param([string]$Title, [string]$Body, [ValidateSet('Info', 'Warn', 'Error')][string]$Level = 'Info')

    if ($NoNotify) { return $false }

    # 1) BurntToast 模块（若用户自行安装）
    if (Get-Module -ListAvailable -Name BurntToast -ErrorAction SilentlyContinue) {
        try {
            Import-Module BurntToast -ErrorAction Stop
            New-BurntToastNotification -Text $Title, $Body -ErrorAction Stop
            return $true
        } catch { }
    }

    # 2) WinRT Toast（Windows PowerShell 5.1 上通常可用）
    try {
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
            [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
        $texts = $template.GetElementsByTagName('text')
        $texts.Item(0).AppendChild($template.CreateTextNode($Title)) | Out-Null
        $texts.Item(1).AppendChild($template.CreateTextNode($Body)) | Out-Null
        $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
        $aumid = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
        return $true
    } catch { }

    # 3) 托盘气泡
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
        $icon = [System.Drawing.SystemIcons]::Information
        $tip = [System.Windows.Forms.ToolTipIcon]::Info
        if ($Level -eq 'Warn') { $icon = [System.Drawing.SystemIcons]::Warning; $tip = [System.Windows.Forms.ToolTipIcon]::Warning }
        if ($Level -eq 'Error') { $icon = [System.Drawing.SystemIcons]::Error; $tip = [System.Windows.Forms.ToolTipIcon]::Error }

        $ni = New-Object System.Windows.Forms.NotifyIcon
        $ni.Icon = $icon
        $ni.Text = '镜像快车道'
        $ni.Visible = $true
        $ni.ShowBalloonTip(5000, $Title, $Body, $tip)
        Start-Sleep -Milliseconds 5200
        $ni.Visible = $false
        $ni.Dispose()
        return $true
    } catch { }

    return $false
}

#endregion

#region outbox

function Resolve-OutboxPath {
    param([string[]]$Dirs)
    if ($Outbox) { return $Outbox }
    if ($Dirs -and $Dirs.Count -gt 0) {
        # 记录统一放进 _mfl-tasks，下载根目录保持干净
        $td = Join-Path $Dirs[0] $TaskFolderName
        if (-not (Test-IsDir $td)) {
            try { New-Item -ItemType Directory -Path $td -Force | Out-Null } catch { }
        }
        return (Join-Path $td 'outbox.txt')
    }
    return $null
}

function Write-OutboxLine {
    param([string]$OutboxPath, [string]$FilePath, [string]$Hash, [string]$State, [string]$Trust = '')

    if (-not $OutboxPath) { return }
    $dir = Split-Path -Parent $OutboxPath
    if ($dir -and -not (Test-IsDir $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    # 毫秒时间戳；扩展对旧版秒级记录也做了兼容
    $ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $line = "{0}|{1}|{2}|{3}" -f $FilePath, $Hash, $State, $ts
    # 第 5 段是可信度，旧版扩展会忽略它
    if ($Trust) { $line = $line + "|" + $Trust }

    for ($i = 0; $i -lt 6; $i++) {
        try {
            [System.IO.File]::AppendAllText($OutboxPath, $line + "`n",
                (New-Object System.Text.UTF8Encoding($false)))
            break
        } catch { Start-Sleep -Milliseconds 150 }
    }
    Trim-Outbox -OutboxPath $OutboxPath
}

function Trim-Outbox {
    param([string]$OutboxPath)
    try {
        if (-not (Test-Path -LiteralPath $OutboxPath)) { return }
        $lines = [System.IO.File]::ReadAllLines($OutboxPath)
        $cut = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]($KeepDays * 86400000)
        $kept = @()
        foreach ($l in $lines) {
            if ([string]::IsNullOrWhiteSpace($l)) { continue }
            $parts = $l.Split('|')
            if ($parts.Count -lt 4) { continue }
            $t = [long]0
            [void][long]::TryParse($parts[3], [ref]$t)
            if ($t -gt 0 -and $t -lt 1000000000000) { $t = $t * 1000 }   # 兼容旧的秒级记录
            if ($t -eq 0 -or $t -ge $cut) { $kept += $l }
        }
        if ($kept.Count -gt $MaxLines) { $kept = $kept[($kept.Count - $MaxLines)..($kept.Count - 1)] }
        if ($kept.Count -ne $lines.Count) {
            [System.IO.File]::WriteAllLines($OutboxPath, [string[]]$kept,
                (New-Object System.Text.UTF8Encoding($false)))
        }
    } catch { }
}

#endregion

#region 校验

function Get-FileSha256 {
    param([string]$Target)
    try { return (Get-FileHash -LiteralPath $Target -Algorithm SHA256 -ErrorAction Stop).Hash.ToLower() }
    catch { return $null }
}

#region 回源复核：任务文件里的哈希是不是真的来自 GitHub

$script:ApiBase = 'https://api.github.com'
$script:RemoteCache = @{}

function New-TrustResult {
    param([string]$State, [string]$Digest = '', [long]$Size = 0, [string]$Note = '')
    return [pscustomobject]@{ State = $State; Digest = $Digest; Size = $Size; Note = $Note }
}

<#
  回源 api.github.com，取该资产"此刻"的官方 digest 与字节数。

  意义：任务文件是磁盘上的普通 JSON，任何本地进程都能改。
  脚本不再无条件相信它，而是拿任务里的锚点（repo / tag / assetId）
  自己去 GitHub 再问一次，两边不一致就当场报警。

  返回 State：
    match / conflict —— 拿到官方 digest，可以对比
    nodigest         —— 资产存在，但 GitHub 没给 digest（老资产 / 私有库）
    unavailable      —— 网络失败、限速、缺少锚点
    skipped          —— -NoNet 关闭
#>
function Get-RemoteAsset {
    param([string]$Repo, [string]$Tag, [long]$AssetId = 0, [string]$AssetName = '')

    if ($NoNet) { return (New-TrustResult 'skipped' -Note '已用 -NoNet 关闭回源复核') }
    if (-not $Repo -or $Repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
        return (New-TrustResult 'unavailable' -Note '任务文件里没有仓库锚点，无法回源')
    }

    $key = '{0}|{1}|{2}|{3}' -f $Repo, $Tag, $AssetId, $AssetName
    if ($script:RemoteCache.ContainsKey($key)) { return $script:RemoteCache[$key] }

    $headers = @{ 'Accept' = 'application/vnd.github+json'; 'User-Agent' = 'mfl-hash-hook' }
    $tok = [string]$env:GITHUB_TOKEN
    if ($tok) { $headers['Authorization'] = "Bearer $tok" }

    # 地址前缀写死，任务文件无法把请求引到别的主机
    #
    # 查询顺序很重要：有数字资产 id 时先按 id 精确查。
    # 同一仓库的多个 release 里常出现同名资产（foo.zip 每个版本都有），
    # 按 id 查才能保证拿到的是"这一个资产",而不是别的版本的同一个名字。
    $uris = @()
    if ($AssetId -gt 0) {
        $uris += ('{0}/repos/{1}/releases/assets/{2}' -f $script:ApiBase, $Repo, $AssetId)
    }
    if ($Tag) {
        $uris += ('{0}/repos/{1}/releases/tags/{2}' -f $script:ApiBase, $Repo, [uri]::EscapeDataString($Tag))
    } else {
        $uris += ('{0}/repos/{1}/releases?per_page=5' -f $script:ApiBase, $Repo)
    }

    $resp = $null
    $single = $false
    $lastErr = ''
    foreach ($uri in $uris) {
        try {
            try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
            $resp = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec $NetTimeoutSec -ErrorAction Stop
            $single = ($uri -match '/releases/assets/')
            break
        } catch {
            $resp = $null
            $lastErr = $_.Exception.Message
        }
    }

    if (-not $resp) {
        $msg = $lastErr
        if ($msg -match '40[13]|429') { $msg = 'API 限速或凭证不足' }
        $r = New-TrustResult 'unavailable' -Note ("回源失败：" + $msg)
        $script:RemoteCache[$key] = $r
        return $r
    }

    # 按 id 查回来的是单个资产对象，直接就是命中项
    if ($single) {
        $size = 0
        try { $size = [long]$resp.size } catch { }
        $digest = [string]$resp.digest
        if ($digest -and $digest -match '^sha256:([a-f0-9]{64})$') {
            Write-Log ("回源命中资产 id={0}（按 id 精确查）" -f $AssetId)
            $r = New-TrustResult 'ok' -Digest $Matches[1].ToLower() -Size $size
            $script:RemoteCache[$key] = $r
            return $r
        }
        $r = New-TrustResult 'nodigest' -Size $size -Note 'GitHub 未提供该资产的 digest'
        $script:RemoteCache[$key] = $r
        return $r
    }

    if ($resp -is [array]) { $resp = $resp | Select-Object -First 1 }
    if (-not $resp -or -not $resp.assets) {
        $r = New-TrustResult 'unavailable' -Note '回源没找到对应的 release'
        $script:RemoteCache[$key] = $r
        return $r
    }

    $assets = @($resp.assets)
    $hit = $null
    if ($AssetId -gt 0) {
        $hit = $assets | Where-Object { [long]$_.id -eq $AssetId } | Select-Object -First 1
    }
    if (-not $hit -and $AssetName) {
        $hit = $assets | Where-Object { [string]$_.name -eq $AssetName } | Select-Object -First 1
    }
    if (-not $hit) {
        $r = New-TrustResult 'unavailable' -Note '回源时该资产已不存在（可能被替换或删除）'
        $script:RemoteCache[$key] = $r
        return $r
    }

    $size = 0
    try { $size = [long]$hit.size } catch { }

    $digest = [string]$hit.digest
    if ($digest -and $digest -match '^sha256:([a-f0-9]{64})$') {
        $r = New-TrustResult 'ok' -Digest $Matches[1].ToLower() -Size $size
    } else {
        $r = New-TrustResult 'nodigest' -Size $size -Note 'GitHub 未提供该资产的 digest'
    }
    $script:RemoteCache[$key] = $r
    return $r
}

<#
  把"下载文件的实际哈希 / 任务文件的 expected / 回源的官方 digest"
  三者合成为一句人话结论。这是整个校验的可信度出口。
#>
function Resolve-Trust {
    param([string]$Actual, [string]$Expected, $Remote)

    if (-not $Expected) {
        return [pscustomobject]@{ Verdict = 'none'; Label = '未取得官方哈希，仅报告本地值'; Detail = '' }
    }

    $exp = $Expected.ToLower()

    if ($Remote -and $Remote.State -eq 'ok') {
        if ($Remote.Digest -ne $exp) {
            return [pscustomobject]@{
                Verdict = 'conflict'
                Label   = '哈希来源冲突：任务文件与 GitHub API 不一致'
                Detail  = "任务文件 $exp`nGitHub API $($Remote.Digest)"
            }
        }
        if ($Actual -eq $exp) {
            return [pscustomobject]@{ Verdict = 'pass'; Label = '已回源 GitHub API 复核一致'; Detail = '' }
        }
        return [pscustomobject]@{ Verdict = 'fail'; Label = '哈希与 GitHub API 一致，但文件内容不符'; Detail = '' }
    }

    # 无法回源时只能信任务文件，必须如实降级
    if ($Actual -ne $exp) {
        return [pscustomobject]@{ Verdict = 'fail'; Label = '哈希不一致，文件可能损坏或被篡改'; Detail = '' }
    }
    $why = if ($Remote) { $Remote.Note } else { '未做回源复核' }
    return [pscustomobject]@{ Verdict = 'pass-unverified'; Label = "仅凭任务文件通过（$why）"; Detail = '' }
}

function Invoke-Verify {
    param(
        [string]$FilePath,
        [string]$Expected,
        [string]$ExpectedSource,
        [string]$DisplayName,
        [string]$OutboxPath,
        [string]$TaskFile,
        $Remote = $null,
        [long]$ExpectedSize = 0
    )

    $name = if ($DisplayName) { $DisplayName } else { Split-Path -Leaf $FilePath }

    if (-not (Test-Path -LiteralPath $FilePath)) {
        Write-Log "文件不存在: $FilePath"
        Show-ResultNotify -Title '校验未能进行' -Body "$name 尚未出现在磁盘上" -Level Warn | Out-Null
        return $null
    }

    $actual = Get-FileSha256 $FilePath
    if (-not $actual) {
        Write-Log "无法计算哈希: $FilePath"
        return $null
    }

    $trust = Resolve-Trust -Actual $actual -Expected $Expected -Remote $Remote
    $match = switch ($trust.Verdict) {
        'pass' { $true }
        'pass-unverified' { $true }
        'fail' { $false }
        'conflict' { $false }
        default { $null }
    }

    # 字节数锚点：文件名相同但大小不同，多半是镜像给了另一个东西
    $sizeNote = ''
    try {
        $len = [long](Get-Item -LiteralPath $FilePath).Length
        $want = if ($ExpectedSize -gt 0) { $ExpectedSize } elseif ($Remote -and $Remote.Size -gt 0) { $Remote.Size } else { 0 }
        if ($want -gt 0 -and $len -ne $want) {
            $sizeNote = "`n大小异常：本地 $len 字节 / 官方 $want 字节"
            Write-Log "大小不一致: $len != $want"
        }
    } catch { }

    # 第 5 段告诉扩展：这次通过是"回源复核过"还是"只信了本地文件"
    $trustTag = switch ($trust.Verdict) {
        'pass' { 'pass' }
        'pass-unverified' { 'pass-unverified' }
        'conflict' { 'conflict' }
        'none' { 'none' }
        default { '' }
    }
    Write-OutboxLine -OutboxPath $OutboxPath -FilePath $FilePath -Hash $actual -State 'ok' -Trust $trustTag

    $src = if ($ExpectedSource) { $ExpectedSource } else { '公告值' }
    if ($trust.Verdict -eq 'none') {
        Show-ResultNotify -Title '已计算哈希' `
            -Body "$name`n未取得官方哈希，仅报告本地值" -Level Warn | Out-Null
    } elseif ($trust.Verdict -eq 'conflict') {
        Show-ResultNotify -Title '哈希来源被改动' `
            -Body "$name`n$($trust.Detail)`n不要相信任务文件，请核对后重下" -Level Error | Out-Null
    } elseif ($match) {
        $lvl = if ($trust.Verdict -eq 'pass') { 'Info' } else { 'Warn' }
        $body = "$name`nSHA-256 与 $src 一致；$($trust.Label)$sizeNote"
        Show-ResultNotify -Title $(if ($lvl -eq 'Info') { '校验通过' } else { '校验通过（未复核）' }) -Body $body -Level $lvl | Out-Null
    } else {
        Show-ResultNotify -Title '校验失败' `
            -Body "$name`n$($trust.Label)$sizeNote`n建议重新下载" -Level Error | Out-Null
    }

    if ($TaskFile) { Remove-TaskFile $TaskFile }

    return [pscustomobject]@{
        Name     = $name
        Path     = $FilePath
        Actual   = $actual
        Expected = $Expected
        Match    = $match
        Source   = $src
        Trust    = $trust
    }
}

#endregion

# 仅供测试/调试：只加载函数定义，不跑主流程
if ($Lib) { return }

#region 主流程

try {
    # 必须用 @() 包住：PowerShell 会把单元素集合展开成字符串，导致 $dirs[0] 取到首字符
    $dirs = @(Resolve-DownloadDirs)
    if ($dirs.Count -eq 0) {
        Write-Log '未找到可用下载目录，请用 -DownloadDir 指定'
        exit 1
    }

    $outboxPath = Resolve-OutboxPath -Dirs $dirs

    # 顺手清掉滞留的任务文件（用户取消下载、或本次之前没挂脚本）
    Clear-StaleTasks -Dirs $dirs

    # 1) 失败回报：不算哈希
    #
    # 下载器失败回调同样会对"任意来源"的下载触发，所以默认只回报扩展接管过的那次，
    # 否则下一个普通文件失败也会弹通知、写记录。
    if ($Status -eq 'fail') {
        $target = $Arg2
        if (-not $target -and $Arg0 -and (Test-Path -LiteralPath $Arg0)) { $target = $Arg0 }

        $leaf = ''
        if ($target -and $target -ne '<下载失败>') { $leaf = Split-Path -Leaf $target }

        $hasTask = $false
        if ($leaf) {
            foreach ($t in (Get-TaskFiles -Dirs $dirs)) {
                $j = Read-TaskFile $t.File.FullName
                if ($j -and $j.name -eq $leaf) { $hasTask = $true; break }
            }
        }

        if (-not $hasTask -and -not $ScanRecent) {
            Write-Log '失败回报没有对应的校验任务，跳过'
            exit 0
        }

        if (-not $target) { $target = '<下载失败>' }
        Write-OutboxLine -OutboxPath $outboxPath -FilePath $target -Hash '' -State 'fail'
        Show-ResultNotify -Title '下载失败' -Body '本次下载未完成，未做哈希校验' -Level Error | Out-Null
        Write-Log '已记录下载失败'
        exit 0
    }

    # 2) 显式传入路径（aria2 / Motrix 风格）
    $explicit = $Arg2
    if (-not $explicit -and $Arg0 -and (Test-Path -LiteralPath $Arg0)) { $explicit = $Arg0 }

    if ($explicit -and (Test-Path -LiteralPath $explicit)) {
        $explicit = (Resolve-Path -LiteralPath $explicit).Path
        $leaf = Split-Path -Leaf $explicit

        $expected = ''
        $source = ''
        $taskFile = ''
        $remote = $null
        $expSize = [long]0
        $taskHit = $false
        foreach ($t in (Get-TaskFiles -Dirs $dirs)) {
            $j = Read-TaskFile $t.File.FullName
            if ($j -and $j.name -eq $leaf) {
                # 命中任务就算"这次要管的下载"，即使扩展没取到期望哈希
                $taskHit = $true
                $taskFile = $t.File.FullName
                if ($j.expected) {
                    $expected = [string]$j.expected
                    $source = if ($j.source) { [string]$j.source } else { '公告值' }
                    if ($j.size) { try { $expSize = [long]$j.size } catch { $expSize = 0 } }
                    $remote = Get-RemoteAsset -Repo ([string]$j.repo) -Tag ([string]$j.tag) `
                        -AssetId ([long]$(if ($j.assetId) { $j.assetId } else { 0 })) -AssetName $leaf
                }
                break
            }
        }

        # 没有任务文件 = 不是扩展接管的 GitHub 下载（例如从别的站下同一个名字）。
        # 默认不处理：不弹通知、不写记录，避免多线程下载器每次完成都打扰。
        if (-not $taskHit -and -not $ScanRecent) {
            Write-Log "没有对应的校验任务，跳过: $leaf"
            exit 0
        }

        $r = Invoke-Verify -FilePath $explicit -Expected $expected -ExpectedSource $source `
            -DisplayName $leaf -OutboxPath $outboxPath -TaskFile $taskFile `
            -Remote $remote -ExpectedSize $expSize
        if ($r) {
            $v = if ($null -eq $r.Match) { '仅计算' } elseif ($r.Match) { '一致' } else { '不一致' }
            Write-Log ("{0}  {1}（{2}）" -f $r.Name, $v, $r.Trust.Label)
        }
        exit 0
    }

    # 3) 任务文件模式：扩展写了期望哈希
    $handled = 0
    $pending = 0
    foreach ($t in (Get-TaskFiles -Dirs $dirs)) {
        $task = Read-TaskFile $t.File.FullName
        if (-not $task -or -not $task.name) { Remove-TaskFile $t.File.FullName; continue }

        $name = [string]$task.name

        # 任务时间用于判断"哪个才是这次下的"（重复下载时会有旧文件）
        $taskTs = [long]0
        if ($task.ts) { try { $taskTs = [long]$task.ts } catch { $taskTs = 0 } }

        # 先在任务文件所在的下载根下找，其次其它候选目录
        $searchOrder = @($t.Root) + @($dirs | Where-Object { $_ -ne $t.Root })
        $found = Find-DownloadedFile -Dirs $searchOrder -Name $name -TaskTs $taskTs

        if (-not $found) {
            $age = (Get-Date) - $t.File.LastWriteTime
            if ($age.TotalSeconds -gt $MaxWaitSeconds) {
                Write-Log "任务已超过等待时间且找不到文件，跳过: $name"
                Remove-TaskFile $t.File.FullName
            } else {
                Write-Log "等待文件落盘: $name"
                $pending++
            }
            continue
        }

        if ($found.Name -ne $name) {
            Write-Log "按副本匹配到: $($found.Name)（原文件名 $name）"
        }

        $expected = if ($task.expected) { [string]$task.expected } else { '' }
        $source = if ($task.source) { [string]$task.source } else { '公告值' }
        $expSize = [long]0
        if ($task.size) { try { $expSize = [long]$task.size } catch { $expSize = 0 } }

        # 不信任务文件，回源核对哈希来源；-NoNet 时自动跳过
        $remote = $null
        if ($expected) {
            $assetId = [long]0
            if ($task.assetId) { try { $assetId = [long]$task.assetId } catch { $assetId = 0 } }
            $remote = Get-RemoteAsset -Repo ([string]$task.repo) -Tag ([string]$task.tag) `
                -AssetId $assetId -AssetName $name
        }

        $r = Invoke-Verify -FilePath $found.FullName -Expected $expected -ExpectedSource $source `
            -DisplayName $name -OutboxPath $outboxPath -TaskFile $t.File.FullName `
            -Remote $remote -ExpectedSize $expSize
        if ($r) {
            $handled++
            $v = if ($null -eq $r.Match) { '仅计算' } elseif ($r.Match) { '一致' } else { '不一致' }
            Write-Log ("{0}  {1}（{2}）" -f $r.Name, $v, $r.Trust.Label)
        }
    }

    # 有任务在等待落盘时，不要用"最新文件"兜底，否则会误判无关文件
    if ($handled -gt 0 -or $pending -gt 0) { exit 0 }

    # 4) 兜底：没有任务文件时，处理最新的下载文件（默认关闭）
    #
    # 下载器会对每一次完成都调用本脚本，其中有大量非 GitHub 的下载。
    # 默认不扫描、不通知、不写记录，避免把无关文件当成待校验对象。
    if (-not $ScanRecent) {
        Write-Log '没有校验任务，跳过（需要"算一下最新下载的哈希"请加 -ScanRecent）'
        exit 0
    }

    $after = (Get-Date).AddMinutes(-$RecentMinutes)
    $newest = Find-NewestFile -Dirs $dirs -After $after
    if (-not $newest) {
        Write-Log '没有待校验的文件'
        exit 0
    }

    Write-Log "无任务文件，按最新文件处理: $($newest.FullName)"
    $r = Invoke-Verify -FilePath $newest.FullName -Expected '' -ExpectedSource '' `
        -DisplayName $newest.Name -OutboxPath $outboxPath -TaskFile ''
    if ($r) { Write-Log ("{0}  仅计算哈希" -f $r.Name) }
    exit 0
} catch {
    Write-Log ("出错: " + $_.Exception.Message)
    exit 1
}

#endregion
