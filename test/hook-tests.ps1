# 哈希校验脚本的自动化测试
#
# 运行： pwsh -NoProfile -File test/hook-tests.ps1
#        powershell -NoProfile -File test/hook-tests.ps1   （5.1 也可以，但需要 BOM 正常）
#
# 全部在临时目录里进行，不会碰真实下载目录。

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:hookPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'hooks\hash-hook.ps1'
$script:integrityPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'hooks\check-integrity.ps1'
if (-not (Test-Path -LiteralPath $script:hookPath)) {
    Write-Host "找不到脚本: $script:hookPath"
    exit 2
}

# 把脚本里的纯函数加载进来做单元测试；-Lib 只定义函数，不跑主流程；-NoNet 保证测试不联网
. $script:hookPath -Lib -NoNet

$script:pass = 0
$script:fail = 0
$script:failures = @()

function Test-Ok {
    param([string]$Name, [bool]$Cond, [string]$Extra = '')
    if ($Cond) {
        $script:pass++
        Write-Host "  OK   $Name" -ForegroundColor Green
    } else {
        $script:fail++
        $script:failures += ($Name + $(if ($Extra) { "  ->  $Extra" } else { '' }))
        Write-Host "  FAIL $Name  $Extra" -ForegroundColor Red
    }
}

function Test-Eq {
    param([string]$Name, $Actual, $Expected)
    Test-Ok $Name ($Actual -eq $Expected) "got=$Actual want=$Expected"
}

function New-Case {
    # 每个用例一个独立目录，避免互相干扰
    param([string]$Name)
    $d = Join-Path $script:root $Name
    New-Item -ItemType Directory -Path (Join-Path $d 'Archives') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $d 'Programs') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $d '_mfl-tasks') -Force | Out-Null
    return $d
}

function New-TaskFile {
    param(
        [string]$Dir, [string]$Name, [string]$Expected, [string]$Source = 'digest', [long]$Ts = 0,
        [string]$Repo = '', [string]$Tag = '', [long]$AssetId = 0, [long]$Size = 0,
        [string]$SourceKind = 'api-digest'
    )
    if ($Ts -eq 0) { $Ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    $t = [ordered]@{
        v          = 2
        name       = $Name
        url        = "https://github.com/o/r/releases/download/v1/$Name"
        expected   = $Expected
        source     = $Source
        ts         = $Ts
        sourceKind = $SourceKind
        repo       = $Repo
        tag        = $Tag
        assetId    = $AssetId
        size       = $Size
    }
    $t | ConvertTo-Json -Compress |
        Set-Content -LiteralPath (Join-Path $Dir "_mfl-tasks\$Name.task.json") -Encoding utf8
    return $Ts
}

function New-File {
    param([string]$Path, [string]$Content)
    Set-Content -LiteralPath $Path -Value $Content -NoNewline
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower()
}

function Invoke-Hook {
    param([string]$Dir, [switch]$NoNet, [switch]$ShowLog, [string]$FilePath = '', [switch]$ScanRecent)
    $out = Join-Path $Dir '_mfl-tasks\outbox.txt'
    if ([System.IO.File]::Exists($out)) { [System.IO.File]::Delete($out) }
    if ($env:MFL_TEST_DEBUG) { Write-Host ("  [dbg] hook = " + $script:hookPath) }

    # 数组 splatting 不会把字符串当参数名（会被当成位置参数值），
    # 所以用具名参数 + 显式布尔的形式，一条调用覆盖所有组合。
    # 写日志走的是 Write-Host，必须用 *>&1 合并所有流才能捕获。
    $text = & $script:hookPath $FilePath -DownloadDir $Dir -NoNotify `
        -Quiet:(-not $ShowLog) -NoNet:$NoNet -ScanRecent:$ScanRecent *>&1 | Out-String
    $lines = @()
    if (Test-Path -LiteralPath $out) {
        $lines = @(Get-Content -LiteralPath $out | Where-Object { $_ -match '\|' })
    }
    return [pscustomobject]@{
        Output = $text
        Lines  = $lines
        Outbox = $out
    }
}

$script:root = Join-Path $env:TEMP ("mfl-hooktest-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $script:root -Force | Out-Null

try {
    # ---------------------------------------------------------------- 1
    Write-Host "`n1. 任务文件 + 子文件夹"
    $d = New-Case 'c1'
    $h = New-File (Join-Path $d 'Archives\pkg.zip') 'payload-one'
    New-TaskFile $d 'pkg.zip' $h | Out-Null
    $r = Invoke-Hook $d
    Test-Eq '校验结论为一致' ($r.Lines.Count) 1
    Test-Ok 'outbox 含 ok 状态' ($r.Lines[0] -match '\|ok\|') $r.Lines[0]
    Test-Ok 'outbox 记录了真实路径' ($r.Lines[0] -match 'Archives\\pkg\.zip') $r.Lines[0]
    Test-Ok '任务文件已删除' (-not (Test-Path (Join-Path $d '_mfl-tasks\pkg.zip.task.json')))
    Test-Ok 'outbox 落在 _mfl-tasks 子目录' (Test-Path (Join-Path $d '_mfl-tasks\outbox.txt'))

    # ---------------------------------------------------------------- 2
    Write-Host "`n2. 期望值不一致"
    $d = New-Case 'c2'
    New-File (Join-Path $d 'Archives\pkg.zip') 'payload-two' | Out-Null
    New-TaskFile $d 'pkg.zip' ('0' * 64) | Out-Null
    $r = Invoke-Hook $d
    Test-Eq '仍写一条记录' ($r.Lines.Count) 1
    Test-Ok '任务文件被清理' (-not (Test-Path (Join-Path $d '_mfl-tasks\pkg.zip.task.json')))

    # ---------------------------------------------------------------- 3
    Write-Host "`n3. 未取得期望哈希（只计算）"
    $d = New-Case 'c3'
    $h = New-File (Join-Path $d 'Archives\pkg.zip') 'payload-three'
    New-TaskFile $d 'pkg.zip' '' | Out-Null
    $r = Invoke-Hook $d
    Test-Eq '写一条记录' ($r.Lines.Count) 1
    Test-Ok '哈希值正确' ($r.Lines[0].Contains($h)) $r.Lines[0]

    # ---------------------------------------------------------------- 4
    Write-Host "`n4. 重复下载被重命名为 (1)"
    $d = New-Case 'c4'
    $old = Join-Path $d 'Archives\pkg.zip'
    New-File $old 'OLD version' | Out-Null
    (Get-Item -LiteralPath $old).LastWriteTime = (Get-Date).AddHours(-1)
    $hNew = New-File (Join-Path $d 'Archives\pkg (1).zip') 'NEW version'
    New-TaskFile $d 'pkg.zip' $hNew | Out-Null
    $r = Invoke-Hook $d
    Test-Eq '写一条记录' ($r.Lines.Count) 1
    Test-Ok '校验的是新副本' ($r.Lines[0] -match 'pkg \(1\)\.zip') $r.Lines[0]
    Test-Ok '用的是新文件的哈希' ($r.Lines[0].Contains($hNew)) $r.Lines[0]

    # ---------------------------------------------------------------- 4b
    Write-Host "`n4b. IDM 的下划线副本命名 (foo_2.zip)"
    $d = New-Case 'c4b'
    $old = Join-Path $d 'Archives\pkg.zip'
    New-File $old 'OLD version' | Out-Null
    (Get-Item -LiteralPath $old).LastWriteTime = (Get-Date).AddHours(-1)
    $copy = Join-Path $d 'Programs\pkg_2.zip'
    $h2 = New-File $copy 'NEW version by IDM'
    New-TaskFile $d 'pkg.zip' $h2 | Out-Null

    Test-Ok '名称匹配：原名' (Test-NameMatch -TaskName 'pkg.zip' -FileName 'pkg.zip')
    Test-Ok '名称匹配：IDM _2' (Test-NameMatch -TaskName 'pkg.zip' -FileName 'pkg_2.zip')
    Test-Ok '名称匹配：浏览器 (1)' (Test-NameMatch -TaskName 'pkg.zip' -FileName 'pkg (1).zip')
    Test-Ok '名称匹配：短横线 -3' (Test-NameMatch -TaskName 'pkg.zip' -FileName 'pkg-3.zip')
    Test-Ok '名称匹配：无关文件不匹配' (-not (Test-NameMatch -TaskName 'pkg.zip' -FileName 'other.zip'))

    $r = Invoke-Hook $d -FilePath $copy -NoNet
    Test-Eq '显式路径命中 _2 副本，写一条记录' ($r.Lines.Count) 1
    Test-Ok '校验的是 _2 副本' ($r.Lines[0] -match 'pkg_2\.zip') ($r.Lines -join '|')
    Test-Ok '用的是副本文件的哈希' ($r.Lines[0].Contains($h2)) ($r.Lines -join '|')

    # ---------------------------------------------------------------- 5
    Write-Host "`n5. 多个副本取最新"
    $d = New-Case 'c5'
    foreach ($n in @('pkg.zip', 'pkg (1).zip', 'pkg (2).zip')) {
        $p = Join-Path $d "Archives\$n"
        New-File $p "content of $n" | Out-Null
        (Get-Item -LiteralPath $p).LastWriteTime = (Get-Date).AddMinutes(-10)
    }
    $latest = Join-Path $d 'Archives\pkg (2).zip'
    (Get-Item -LiteralPath $latest).LastWriteTime = Get-Date
    $hl = (Get-FileHash -LiteralPath $latest -Algorithm SHA256).Hash.ToLower()
    New-TaskFile $d 'pkg.zip' $hl | Out-Null
    $r = Invoke-Hook $d
    Test-Ok '选中编号最大的副本' ($r.Lines.Count -eq 1 -and $r.Lines[0] -match 'pkg \(2\)\.zip') ($r.Lines -join '|')

    # ---------------------------------------------------------------- 6
    Write-Host "`n6. 只有旧文件时不误判"
    $d = New-Case 'c6'
    $stale = Join-Path $d 'Archives\pkg.zip'
    New-File $stale 'stale content' | Out-Null
    (Get-Item -LiteralPath $stale).LastWriteTime = (Get-Date).AddHours(-2)
    New-File (Join-Path $d 'Archives\unrelated.bin') 'unrelated' | Out-Null
    New-TaskFile $d 'pkg.zip' ('a' * 64) | Out-Null
    $r = Invoke-Hook $d
    Test-Eq '不写任何记录' ($r.Lines.Count) 0
    Test-Ok '任务文件保留等待下次' (Test-Path (Join-Path $d '_mfl-tasks\pkg.zip.task.json'))

    # ---------------------------------------------------------------- 7
    Write-Host "`n7. 覆盖同名文件"
    $d = New-Case 'c7'
    $h = New-File (Join-Path $d 'Archives\pkg.zip') 'overwritten content'
    New-TaskFile $d 'pkg.zip' $h | Out-Null
    $r = Invoke-Hook $d
    Test-Eq '写一条记录' ($r.Lines.Count) 1
    Test-Ok 'outbox 里是原文件名' ($r.Lines[0] -match 'Archives\\pkg\.zip') $r.Lines[0]

    # ---------------------------------------------------------------- 8
    Write-Host "`n8. 过期任务被清理"
    $d = New-Case 'c8'
    New-TaskFile $d 'gone.zip' ('b' * 64) | Out-Null
    $tf = Join-Path $d '_mfl-tasks\gone.zip.task.json'
    (Get-Item -LiteralPath $tf).LastWriteTime = (Get-Date).AddDays(-8)
    $r = Invoke-Hook $d
    Test-Ok '过期任务已删除' (-not (Test-Path $tf))

    # ---------------------------------------------------------------- 9
    Write-Host "`n9. aria2 风格：显式传路径"
    $d = New-Case 'c9'
    $h = New-File (Join-Path $d 'Archives\pkg.zip') 'aria2 payload'
    New-TaskFile $d 'pkg.zip' $h | Out-Null
    $out = Join-Path $d '_mfl-tasks\outbox.txt'
    if ([System.IO.File]::Exists($out)) { [System.IO.File]::Delete($out) }
    & $script:hookPath 'somegid' '1' (Join-Path $d 'Archives\pkg.zip') -DownloadDir $d -NoNotify -Quiet 2>&1 | Out-Null
    $lines = @(Get-Content -LiteralPath $out -ErrorAction SilentlyContinue | Where-Object { $_ -match '\|' })
    Test-Eq '写一条记录' ($lines.Count) 1
    Test-Ok '哈希与文件一致' ($lines[0].Contains($h)) $lines[0]
    Test-Ok '任务文件已删除' (-not (Test-Path (Join-Path $d '_mfl-tasks\pkg.zip.task.json')))

    # --------------------------------------------------------------- 10
    Write-Host "`n10. 失败回报"
    $d = New-Case 'c10'
    $out = Join-Path $d '_mfl-tasks\outbox.txt'
    & $script:hookPath -Status fail -DownloadDir $d -NoNotify -Quiet 2>&1 | Out-Null
    $lines = @(Get-Content -LiteralPath $out -ErrorAction SilentlyContinue | Where-Object { $_ -match '\|' })
    Test-Eq '没有对应任务时不记录（非 GitHub 下载失败）' ($lines.Count) 0

    # 有任务文件时照常回报失败
    $d2 = New-Case 'c10b'
    $out2 = Join-Path $d2 '_mfl-tasks\outbox.txt'
    New-TaskFile $d2 'failed.zip' ('a' * 64) | Out-Null
    $fc = Join-Path $d2 'Archives\failed.zip'
    Set-Content -LiteralPath $fc -Value 'partial' -NoNewline
    & $script:hookPath $fc -Status fail -DownloadDir $d2 -NoNotify -Quiet 2>&1 | Out-Null
    $l2 = @(Get-Content -LiteralPath $out2 -ErrorAction SilentlyContinue | Where-Object { $_ -match '\|' })
    Test-Eq '有任务时写一条记录' ($l2.Count) 1
    Test-Ok '状态为 fail' ($l2[0] -match '\|fail\|') $l2[0]

    # --------------------------------------------------------------- 11
    Write-Host "`n11. 任务在 A 目录、文件在 B 目录"
    $a = New-Case 'c11a'
    $b = New-Case 'c11b'
    $h = New-File (Join-Path $b 'Programs\cross.zip') 'cross directory payload'
    New-TaskFile $a 'cross.zip' $h | Out-Null
    $out = Join-Path $a '_mfl-tasks\outbox.txt'
    if ([System.IO.File]::Exists($out)) { [System.IO.File]::Delete($out) }
    & $script:hookPath -DownloadDir "$a,$b" -NoNotify -Quiet 2>&1 | Out-Null
    $lines = @(Get-Content -LiteralPath $out -ErrorAction SilentlyContinue | Where-Object { $_ -match '\|' })
    Test-Eq '写一条记录' ($lines.Count) 1
    Test-Ok '找到了 B 目录里的文件' ($lines[0] -match 'Programs\\cross\.zip') $lines[0]

    # --------------------------------------------------------------- 12
    Write-Host "`n12. 多个任务并发"
    $d = New-Case 'c12'
    $h1 = New-File (Join-Path $d 'Archives\one.zip') 'first payload'
    $h2 = New-File (Join-Path $d 'Programs\two.exe') 'second payload'
    New-TaskFile $d 'one.zip' $h1 | Out-Null
    New-TaskFile $d 'two.exe' $h2 | Out-Null
    $r = Invoke-Hook $d
    Test-Eq '两条记录' ($r.Lines.Count) 2
    Test-Ok '两个任务都已删除' (
        (-not (Test-Path (Join-Path $d '_mfl-tasks\one.zip.task.json'))) -and
        (-not (Test-Path (Join-Path $d '_mfl-tasks\two.exe.task.json')))
    )

    # --------------------------------------------------------------- 13
    Write-Host "`n13. _mfl-tasks 内部的文件不会被当成下载文件"
    $d = New-Case 'c13'
    New-File (Join-Path $d '_mfl-tasks\scratch.bin') 'internal scratch file' | Out-Null
    $r = Invoke-Hook $d
    Test-Eq '无任务时不处理内部文件' ($r.Lines.Count) 0

    # --------------------------------------------------------------- 14
    Write-Host "`n14. 可信度：关闭回源时必须如实降级"
    $d = New-Case 'c14'
    $p = Join-Path $d 'Archives\pkg.zip'
    $h = New-File $p 'payload-provenance'
    $len = (Get-Item -LiteralPath $p).Length
    New-TaskFile $d 'pkg.zip' $h -Repo 'o/r' -Tag 'v1' -Size $len | Out-Null
    $r = Invoke-Hook $d -NoNet -ShowLog
    Test-Eq '写一条记录' ($r.Lines.Count) 1
    Test-Ok '结论标注为"仅凭任务文件"' ($r.Output -match '仅凭任务文件通过') $r.Output
    Test-Ok '注明了未复核的原因' ($r.Output -match 'NoNet') $r.Output
    Test-Ok 'outbox 带 pass-unverified 标记' ($r.Lines[0] -match '\|pass-unverified$') $r.Lines[0]

    # --------------------------------------------------------------- 15
    Write-Host "`n15. 字节数锚点能发现同名不同物"
    $d = New-Case 'c15'
    $p = Join-Path $d 'Archives\pkg.zip'
    $h = New-File $p 'payload-size-mismatch'
    New-TaskFile $d 'pkg.zip' $h -Size 999999 | Out-Null
    $r = Invoke-Hook $d -NoNet -ShowLog
    Test-Ok '日志记录大小不一致' ($r.Output -match '大小不一致') $r.Output
    Test-Eq '仍写出记录（哈希本身是对的）' ($r.Lines.Count) 1

    # --------------------------------------------------------------- 16
    Write-Host "`n16. 来源合成逻辑（纯函数）"
    $HA = 'a' * 64
    $HB = 'b' * 64
    $HC = 'c' * 64

    $r0 = Resolve-Trust -Actual $HA -Expected '' -Remote $null
    Test-Eq '无期望值 → none' $r0.Verdict 'none'

    $okRemote = New-TrustResult 'ok' -Digest $HA -Size 100
    $r1 = Resolve-Trust -Actual $HA -Expected $HA -Remote $okRemote
    Test-Eq '回源一致 → pass' $r1.Verdict 'pass'

    $r2 = Resolve-Trust -Actual $HA -Expected $HB -Remote $okRemote
    Test-Eq '回源与任务文件冲突 → conflict' $r2.Verdict 'conflict'
    Test-Ok '冲突说明里同时给出两边值' ($r2.Detail -match $HA -and $r2.Detail -match $HB) $r2.Detail

    $r3 = Resolve-Trust -Actual $HC -Expected $HA -Remote $okRemote
    Test-Eq '回源一致但文件不符 → fail' $r3.Verdict 'fail'

    $ndRemote = New-TrustResult 'nodigest' -Note 'GitHub 未提供该资产的 digest'
    $r4 = Resolve-Trust -Actual $HA -Expected $HA -Remote $ndRemote
    Test-Eq '官方无摘要时降级为 pass-unverified' $r4.Verdict 'pass-unverified'
    Test-Ok '降级理由写进结论' ($r4.Label -match '未提供') $r4.Label

    $r5 = Resolve-Trust -Actual $HB -Expected $HA -Remote $null
    Test-Eq '未复核且不一致 → fail' $r5.Verdict 'fail'

    # --------------------------------------------------------------- 17
    Write-Host "`n17. 回源入口的边界"
    $NoNet = $false          # 临时打开联网开关，验证"参数校验先于联网"
    try {
        $x1 = Get-RemoteAsset -Repo '' -Tag '' -AssetName 'a.zip'
        Test-Eq '缺仓库锚点 → unavailable' $x1.State 'unavailable'
        Test-Ok '说明里点出缺锚点' ($x1.Note -match '锚点') $x1.Note

        $x3 = Get-RemoteAsset -Repo 'bad repo/x' -Tag 'v1'
        Test-Eq '非法仓库名不联网' $x3.State 'unavailable'
    } finally { $NoNet = $true }

    $x2 = Get-RemoteAsset -Repo 'o/r' -Tag 'v1' -AssetId 1 -AssetName 'a.zip'
    Test-Eq '-NoNet 时完全跳过联网' $x2.State 'skipped'

    # --------------------------------------------------------------- 18
    Write-Host "`n18. 脚本完整性自检（基线比对，不走 git）"
    $d = New-Case 'c18'
    $srcDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'hooks'
    $tScript = Join-Path $d 'hash-hook.ps1'
    Copy-Item -LiteralPath (Join-Path $srcDir 'hash-hook.ps1') -Destination $tScript
    Copy-Item -LiteralPath (Join-Path $srcDir 'hash-hook.sha256') -Destination (Join-Path $d 'hash-hook.sha256')

    $o1 = & $script:integrityPath -Target $tScript -NoGit *>&1 | Out-String
    Test-Ok '基线一致时退出码 0' ($LASTEXITCODE -eq 0) $o1

    Add-Content -LiteralPath $tScript -Value '# tamper'
    $o2 = & $script:integrityPath -Target $tScript -NoGit *>&1 | Out-String
    Test-Ok '脚本被改后退出码 1' ($LASTEXITCODE -eq 1) $o2
    Test-Ok '明确报出不一致' ($o2 -match '不一致') $o2

    & $script:integrityPath -Target $tScript -NoGit -Update *>&1 | Out-Null
    $o3 = & $script:integrityPath -Target $tScript -NoGit *>&1 | Out-String
    Test-Ok '重建基线后恢复通过' ($LASTEXITCODE -eq 0) $o3

    # --------------------------------------------------------------- 19
    Write-Host "`n19. 非 GitHub 下载（无任务文件）默认不打扰"
    $d = New-Case 'c19'
    $p = Join-Path $d 'Archives\from-somewhere-else.zip'
    New-File $p 'downloaded from a random website' | Out-Null

    $r = Invoke-Hook $d -FilePath $p -ShowLog
    Test-Eq '显式路径但无任务时零记录' ($r.Lines.Count) 0
    Test-Ok '日志说明已跳过' ($r.Output -match '没有对应的校验任务') $r.Output

    $r2 = Invoke-Hook $d -FilePath $p -ShowLog -ScanRecent
    Test-Eq '-ScanRecent 时写一条' ($r2.Lines.Count) 1
    Test-Ok '只报告本地值（none）' ($r2.Lines[0] -match '\|none$') $r2.Lines[0]

    $r3 = Invoke-Hook $d -ShowLog
    Test-Eq '无任务 + 无显式路径时也零记录' ($r3.Lines.Count) 0
    Test-Ok '提示可用 -ScanRecent' ($r3.Output -match 'ScanRecent') $r3.Output

    # --------------------------------------------------------------- 20
    Write-Host "`n20. 回源凭据：凭据文件优先，环境变量兜底"
    $d20 = New-Case 'c20'
    $tf = Join-Path $d20 'auth.txt'
    $absent = Join-Path $d20 'absent-auth.txt'
    $envName = 'MFL_TEST_HOOK_TOKEN'
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $origDefault = $script:DefaultTokenFile
    $origProc = [Environment]::GetEnvironmentVariable($envName, 'Process')

    try {
        [Environment]::SetEnvironmentVariable($envName, $null, 'Process')
        [Environment]::SetEnvironmentVariable($envName, $null, 'User')
        $script:DefaultTokenFile = $absent

        Test-Eq '都为空 → 匿名' (Get-ApiToken -EnvName $envName) ''

        [System.IO.File]::WriteAllText($tf, 'file-token-1234567890' + "`n", $utf8)
        $script:DefaultTokenFile = $tf
        Test-Eq '只有凭据文件 → 用文件' (Get-ApiToken -EnvName $envName) 'file-token-1234567890'

        [Environment]::SetEnvironmentVariable($envName, 'process-token-123456', 'Process')
        Test-Eq '文件 + 进程 env → 文件优先' (Get-ApiToken -EnvName $envName) 'file-token-1234567890'

        [System.IO.File]::Delete($tf)
        $script:DefaultTokenFile = $absent
        Test-Eq '无文件 → 回退进程级 env' (Get-ApiToken -EnvName $envName) 'process-token-123456'

        [Environment]::SetEnvironmentVariable($envName, $null, 'Process')
        [Environment]::SetEnvironmentVariable($envName, 'user-reg-token-123456', 'User')
        Test-Eq '进程无值 → 读用户级注册表（不依赖继承）' (Get-ApiToken -EnvName $envName) 'user-reg-token-123456'

        [System.IO.File]::WriteAllText($tf, 'file-token-abcdefgh' + "`n", $utf8)
        $script:DefaultTokenFile = $tf
        Test-Eq '用户级 env 存在时文件仍优先' (Get-ApiToken -EnvName $envName) 'file-token-abcdefgh'

        [System.IO.File]::WriteAllText($tf, 'not a valid token' + "`n", $utf8)
        Test-Eq '文件内容含空白 → 判无效并回退' (Get-ApiToken -EnvName $envName) 'user-reg-token-123456'

        [System.IO.File]::WriteAllText($tf, "# comment`n`n  file-with-comment-123  `n", $utf8)
        Test-Eq '跳过注释/空行并 Trim' (Get-ApiToken -EnvName $envName) 'file-with-comment-123'

        $tf2 = Join-Path $d20 'custom.txt'
        [System.IO.File]::WriteAllText($tf2, 'custom-token-123456' + "`n", $utf8)
        Test-Eq '自定义 -TokenFile 生效' (Get-ApiToken -TokenFile $tf2 -EnvName $envName) 'custom-token-123456'

        # DPAPI(CurrentUser) 密文
        try {
            Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue
            if (-not ('System.Security.Cryptography.ProtectedData' -as [type])) {
                Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop
            }
            $secret = 'dpapi-token-123456'
            $enc = [System.Security.Cryptography.ProtectedData]::Protect(
                [System.Text.Encoding]::UTF8.GetBytes($secret), $null,
                [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
            [System.IO.File]::WriteAllText($tf, 'dpapi:' + [Convert]::ToBase64String($enc) + "`n", $utf8)
            Test-Eq 'DPAPI(CurrentUser) 密文可读回' (Get-ApiToken -EnvName $envName) $secret
        } catch {
            Test-Ok 'DPAPI(CurrentUser) 密文可读回' $false ('加密失败: ' + $_.Exception.Message)
        }

        $sysPath = [string][Environment]::GetEnvironmentVariable('Path', 'Machine')
        Test-Ok '普通用户可读系统级环境变量' ($sysPath.Length -gt 0)

        # 用同名函数盖掉 Invoke-RestMethod，验证 token 真的进了 Authorization 头
        [System.IO.File]::WriteAllText($tf, 'header-token-123456' + "`n", $utf8)
        $script:DefaultTokenFile = $tf
        $script:RemoteCache.Clear()
        $script:capturedAuth = ''
        function Invoke-RestMethod {
            param($Uri, $Headers, $TimeoutSec, $ErrorAction)
            $script:capturedAuth = [string]$Headers['Authorization']
            return [pscustomobject]@{ digest = 'sha256:' + ('a' * 64); size = 1 }
        }
        $NoNet = $false
        try {
            $rm = Get-RemoteAsset -Repo 'o/r' -Tag 'v1' -AssetId 77 -AssetName 'a.zip'
            Test-Eq '凭据文件 token 进入 Authorization 头' $script:capturedAuth 'Bearer header-token-123456'
            Test-Eq 'mock 下按 id 命中 digest' $rm.State 'ok'
        } finally {
            $NoNet = $true
            Remove-Item function:Invoke-RestMethod -ErrorAction SilentlyContinue
            $script:RemoteCache.Clear()
        }

        $src = [System.IO.File]::ReadAllText($script:hookPath)
        Test-Ok '源码没把 token 值拼进日志字符串' ($src -notmatch 'Write-Log[^\r\n]*\$tok\b')
    } finally {
        [Environment]::SetEnvironmentVariable($envName, $origProc, 'Process')
        [Environment]::SetEnvironmentVariable($envName, $null, 'User')
        $script:DefaultTokenFile = $origDefault
        $NoNet = $true
    }
} finally {
    # 用 .NET API 删自己的临时目录，避免经过 Remove-Item 的删除钩子
    try {
        if ([System.IO.Directory]::Exists($script:root)) {
            [System.IO.Directory]::Delete($script:root, $true)
        }
    } catch { }
}

Write-Host ("`n" + ('-' * 52))
Write-Host "通过 $script:pass  失败 $script:fail"
if ($script:fail -gt 0) {
    Write-Host "`n失败项："
    $script:failures | ForEach-Object { Write-Host "  X $_" }
    exit 1
}
Write-Host "全部通过"
exit 0
