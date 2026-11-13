# 哈希校验（可选）

默认关闭。开启后有两种用法：

| 用法 | 需要什么 | 体验 |
|---|---|---|
| **自动校验**（推荐） | 设置页开「哈希校验」+「下载时写校验任务」，再把脚本挂到下载器 | 下载完成自动比对并弹系统通知 |
| **手动校验** | 什么都不用配 | 校验页填地址取期望值 → 选文件算实际值 |

## 自动校验的链路

```
你在 GitHub 点下载
   └→ 扩展取期望哈希，写成 _mfl-tasks/<文件名>.task.json（落在浏览器下载目录）
下载器把文件下到磁盘（可以是任意子文件夹）
   └→ 下载器回调运行 hash-hook.ps1
        └→ 脚本自己找到下载目录 → 找到任务文件 → 按文件名找到下载文件
             └→ 算 SHA-256 → 与期望值比对 → 弹系统通知 → 写 outbox.txt → 删任务文件
```

**扩展只负责写一个 JSON，不读磁盘、不轮询、不弹通知。** 校验与通知全部由脚本完成，所以这套在 Edge / Chrome / Firefox 上都能用，也不需要任何目录授权。

## 非 GitHub 的下载会被忽略

下载器对**每一次**完成都会回调脚本，其中大半是从别的站下的文件。脚本靠任务文件区分：

| 情况 | 脚本行为 |
|---|---|
| 有同名任务文件（扩展接管的 GitHub 下载） | 校验并通知 |
| 有任务文件但文件名对不上 | 不处理那个文件（任务留给它自己的下载） |
| 没有任务文件（非 GitHub 或绕过扩展的下载） | **静默退出**：不弹通知、不写记录、不算哈希 |
| 想只算一下最新下载文件的哈希 | 手动加 `-ScanRecent`，此时只报本地值，徽章为「仅本地值」，绝不判通过 |

挂到 IDM 上之后，下载普通文件不会被「已计算哈希」打扰，也不会把无关文件混进校验历史。

## 脚本会自动找下载目录

不传 `-DownloadDir` 时，脚本依次探测并去重（含符号链接还原）：

```
Chrome / Edge / Brave / Chromium / Vivaldi 各 Profile 的 download.default_directory
Firefox 各 Profile 的 browser.download.dir
IDM 的 LocalPathW
系统「下载」已知文件夹
```

浏览器下载目录与 IDM 目录不同时，脚本会把两边都扫一遍。

## 下载文件在子文件夹里也没问题

IDM 默认按类型分类存放（`Archives/`、`Programs/`、`Documents/`、`Images/`、`Videos/`…）。脚本递归查找，只跳过 `_mfl-tasks` 自身和临时文件（`.part` / `.dwl` / `.aria2` 等）。

## 判定规则

一个任务只有**同时满足**下面条件才会被比对：

1. 任务文件里的 `name` 能在下载目录里找到对应文件；
2. 文件能读出 SHA-256；
3. 任务文件里带了 `expected`（没带就只报告本地哈希，不判定）。

`expected` 的来源优先级：API 的 `digest` → 边车 `.sha256` → `SHA256SUMS` 类清单 → release 正文。老仓库可能一个都没有，此时脚本只报「已计算哈希」。

## 哈希来源可信度

任务文件是下载目录里一个普通 JSON，**任何能写那个目录的程序都能改它**。所以脚本不是「读 `expected` 然后比对」就完事，而是分三层看：

| 层 | 由谁提供 | 主要防什么 |
|---|---|---|
| 官方摘要 | `api.github.com` 对该资产的 `digest` | 镜像 / CDN 投毒、缓存串味、续传拼错 |
| 来源锚点 | 任务文件的 `repo` / `tag` / `assetId` / `size` | 任务文件被改：脚本拿锚点自己回源问一次 |
| 内容哈希 | 本地文件的 SHA-256 | 传输损坏、落地后被替换 |

判定口径：

| 情况 | 结论 |
|---|---|
| 任务文件的 `expected` ≠ 官方 `digest` | **报「哈希来源被改动」，不判通过**（冲突时拒绝采信，而不是二选一） |
| 官方只有边车 / 清单 / 正文里的哈希（无 `digest`） | 照常比对，但只算单源，不标「已回源」 |
| 回源失败、限流、离线 | 降级为「仅凭任务文件通过」，通知与记录里写明原因 |
| 资产字节数与本地文件不符 | 单独提示「大小异常」（同名不同物） |

`outbox.txt` 第 5 段记录可信度，校验页会显示徽章：`已回源复核` / `未复核` / `来源冲突` / `仅本地值`。旧格式（4 段）仍然能读，只是没有徽章。

### 同名资产、多个版本怎么区分

同一仓库的不同 release 常放同名文件（`foo.zip` 每个版本放一个），同一个 release 里也可能并列多个版本（`foo-1.0.0.zip` / `foo-1.1.0.zip`）。三道闸门：

1. **URL 里的 tag**：`/releases/download/v1.0.0/foo.zip` 的 tag 必须解析出来。丢掉它就会退化成「查最新版」，然后拿新版的哈希去比老版本的文件 —— 1.3.1 修的就是这个（之前 `download` 形态的 tag 被丢弃了）。
2. **资产 id**：任务文件里带 `assetId`（数字，永不变）。回源时直接 `GET /releases/assets/<id>`，同名也认不错；只有按 id 查不到（资产被删）才退到「按 tag 找 release、按名字找资产」。
3. **拒绝猜**：粘 release 页面而该 release 有多个资产时直接报错，要求给具体文件的直链，不会把某个资产的哈希安到目标文件头上。

| 你给的东西 | 能定位到什么 |
|---|---|
| `…/releases/tag/v1.0.0` 且该 release 只有 1 个资产 | 该资产 |
| `…/releases/tag/v1.0.0` 且有多个资产 | 报错，要求直链 |
| `…/releases/download/v1.0.0/foo.zip` | 精确到 tag + 文件名，回源再精确到 assetId |
| `…/releases/latest/download/foo.zip` | 最新 release 里的 foo.zip |

完全不想联网：给脚本加 `-NoNet`，回源整段跳过，行为退化成「只信任务文件」并如实标注。

### 它挡不住什么（别高估）

- **本机已被入侵**：攻击者既能改下载文件，也能改任务文件，还能改脚本本身。写死在本地的密钥没有意义 —— 扩展是公开代码，不存在秘密。这种情况只能靠离线核对（另一台机器、或对照上游签名）。
- **上游自己出错或作恶**：`digest` 只证明「你拿到的是作者上传的那份字节」，不证明「那份是安全的」。
- **脚本被替换**：把 `hooks/hash-hook.ps1` 留在 git 仓库里，用 `git status` / `git diff` 对照上游，是最省事的一次性完整性检查。
- **本地代理做了 TLS 中间人**：代理能改写 `api.github.com` 的响应，回源复核随之失效。装过可疑根证书的机器上，不要把这条链当强保证。

一句话：这套机制保证的是**「镜像没骗你」**，不保证**「这台机器没被攻破」**。

## 脚本本身的完整性

回源复核再严，前提是**跑的那份脚本没被换过**。`hooks/hash-hook.ps1` 配了一个自检：

```powershell
pwsh -NoProfile -File hooks\check-integrity.ps1
# 你自己改过脚本、确认无误后重建基线
pwsh -NoProfile -File hooks\check-integrity.ps1 -Update
```

它做两层对账，缺一不可：

| 层 | 检查 | 挡住什么 |
|---|---|---|
| 基线 | 文件 SHA-256 是否等于 `hooks/hash-hook.sha256` | 随手改脚本 |
| git | 脚本与基线是否还有未提交的改动 | 改脚本 + 顺手改基线的绕过 |

失败时的两种含义要分清：

- **只有基线不一致** → 文件被改过，但基线还是仓库里的原值；
- **基线不一致 + git 报改动** → 连基线一起被改了，或者是你自己改完没提交。

退出码：`0` 一致 / `1` 不一致 / `2` 缺基线。**改了脚本不提交，自检就会一直报红** —— 这是故意的，提交本身就是「我确认过这次改动」的记录。

> 之所以不走 Authenticode 签名：自签的根证书装在本机信任库里，有管理员权限的东西可以装自己的证书重签，你看到的仍是「签名有效」；而 `.ps1` 的签名只有执行策略设为 `AllSigned` 时才被检查，`RemoteSigned` 下等于没有。真要签，得用 CA 签发的代码签名证书，代价与收益对个人脚本不划算。

## 重复下载同一个文件

IDM 遇到同名文件会提示，两种选择脚本都认：

| 你的选择 | 磁盘上的结果 | 脚本怎么找 |
|---|---|---|
| **覆盖** | 还是 `foo.zip`，但修改时间更新 | 选它 |
| **重命名** | `foo (1).zip` / `foo (2).zip` | 认这个副本编号，取最新的那个 |

判据是「文件名匹配（含副本编号）**且**修改时间不早于任务创建时间」。所以：

- 之前下过的旧文件不会被误选（时间早于任务，直接跳过）；
- 新的副本或覆盖后的文件会被选中；
- 用户取消下载时，任务文件留着等 30 秒，之后按过期处理。

任务文件本身不会因为重命名而堆积 —— IDM 重命名的是下载的文件，扩展写的任务文件始终是 `<原文件名>.task.json`，重复下载时直接覆盖。如果有人把文件改成完全无关的名字，脚本就找不到了，这种情况用校验页手动校验。

## 目录整洁

所有中间产物都在下载目录下的 `_mfl-tasks\` 里，下载根目录只有你下载的文件：

```
下载目录\
├── Archives\  Programs\  Documents\ …     ← 你的文件（IDM 分类）
└── _mfl-tasks\
    ├── foo.zip.task.json                  ← 待校验任务，用完即删
    └── outbox.txt                         ← 校验历史（保留最近 200 条 / 7 天）
```

- 任务文件：校验完成后立即删除；超过 7 天未处理的会在下次运行时清掉；
- `outbox.txt`：自动裁剪，不需要手动维护；
- 整个 `_mfl-tasks` 目录可以直接删，下次运行会重建。

## 查看历史

校验结果写在 `_mfl-tasks\outbox.txt`。在校验页授权下载根目录即可查看（脚本会先找 `_mfl-tasks`，找不到再兼容旧版写在根目录的 `outbox.txt`）。纯展示用途，不授权也不影响自动校验。

## 边界

- 扩展只能把任务文件写进**浏览器自己的下载目录**（`downloads` API 的硬边界，越界路径一律拒绝）；
- 直接往下载器里粘贴 GitHub 链接（不经过页面点击）不会产生任务文件，这种用校验页手动校验；
- Firefox 的下载目录若与 IDM 目录不同，脚本会两边都扫，但任务文件只落在浏览器那边。

## 脚本挂载方式

**这个脚本不在扩展包内，需要你自己下载。** 使用前请阅读源码并自行审查其安全性与可靠性；作者仅保证它在开发者本人的设备上可用，不对其他环境作任何承诺。

- aria2 / Motrix / Gopeed：把脚本挂到「下载完成」与「下载失败」回调；
- IDM：见下。

**IDM** 没有通用的「下载完成后运行程序」选项，唯一可用的钩子是「病毒检查」那一栏（官方文档明确：下载完成时用 `[File]` 替换成文件路径去 CreateProcess）。设置路径：

1. 选项 → 「下载」标签页 → 「病毒检查设置」→ 编辑；
2. 程序填 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`；
3. 参数填（路径换成你自己的，`[File]` 原样保留）：

   ```
   -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%LOCALAPPDATA%\MirrorFastlane\hash-hook.ps1" "[File]"
   ```

4. 确定保存。

解释器用哪个都行，实测同一脚本（含目录探测）的启动开销：

| 解释器 | 路径 | 中位耗时 |
|---|---|---|
| Windows PowerShell 5.1 | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` | 558 ms |
| scoop 的 pwsh 7 | `…\scoop\apps\pwsh\current\pwsh.exe` | 606 ms |
| scoop 的 shim | `…\scoop\shims\pwsh.exe` | 651 ms |

推荐 5.1：系统自带、路径恒定、最快，不受包管理器状态影响。若坚持用 scoop 的 pwsh，填 `apps\pwsh\current\pwsh.exe` —— `current` 是 junction，升级后仍指向新版本；不要填 `shims\pwsh.exe`，那是多一层转发，慢 45 ms，且 scoop 重装时会重建。代价是：scoop 卸载、迁移盘符或 `current` 重建期间，IDM 的钩子会静默失败（IDM 只记一条 CreateProcess 错误）。

IDM 会对**每一次**下载完成都调用它，脚本靠任务文件区分：没有对应任务的（非 GitHub 下载）静默退出，不弹通知、不写记录。

失败回调再加 `-Status fail`。脚本读取本地文件、计算 SHA-256、把结果写入 `outbox.txt` 并弹通知；此外**默认向 `api.github.com` 发一次只读 GET 回源复核**（可用 `-NoNet` 完全关闭联网）。它不上传文件内容、不执行下载内容、不扫描任务目录之外的文件。

通知按以下顺序降级，任一成功即可：BurntToast 模块 → WinRT Toast（PowerShell 5.1）→ 托盘气泡。三者都不可用时静默跳过，不影响校验与 outbox 记录。

## 回源凭据（可选，建议配）

`hash-hook.ps1` 会拿任务文件里的 `repo / tag / assetId` 回源 `api.github.com` 复核官方 digest。匿名访问按**出口 IP** 限 60 次/小时，走代理时出口常被共享，密集下载很容易撞 403，结果降级成 `pass-unverified`。配一个只读 token 即可按 token 计 5000 次/小时。

两种来源，**凭据文件优先**：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | 凭据文件 | 与 `hash-hook.ps1` 同目录的 `auth.txt`，或启动时 `-TokenFile` 指定 |
| 2 | 环境变量 `GITHUB_TOKEN` | 进程级 → 用户级 `HKCU\Environment` → 系统级 `HKLM`；后两级直接读注册表，**无需重启 IDM** |

**最省事：不带任何参数运行。** 脚本先提示粘贴 PAT（不回显），随后自动跑完剩余全部步骤：写入 DPAPI 密文 → 收紧 ACL → 用 IDM 同款 `powershell.exe 5.1` 读回解密 → 带 token 打一次 `api.github.com/rate_limit` 验证认证生效 → 输出路径与状态。token 不进命令行、日志、`outbox.txt` 或通知。

**脚本可以从任意目录运行**（下载文件夹、临时目录、U 盘都行）。因为 `hash-hook.ps1` 只读「自己同目录的 `auth.txt`」，工具按下面顺序决定凭据写到哪：

1. IDM 注册表 `HKCU\Software\DownloadManager\VScannerParameters` 里 `-File` 指向的 `hash-hook.ps1` 所在目录 —— 权威来源，与脚本当前在哪无关；
2. 没挂载 IDM 时退到 `%LOCALAPPDATA%\MirrorFastlane\`；
3. 再没有就写到本脚本当前所在目录（便携模式），并提示「挂载 IDM 后重新运行一次」。

自检还会比对「IDM hook 默认读取的 `auth.txt` 路径」与「本次实际写入路径」，不一致时直接警告，避免配完却读不到。

命令写法（`%VAR%` 是 CMD 语法，PowerShell 里要用 `$env:VAR`；用 `.cmd` 包装则两种 shell 通吃）：

```
:: CMD 提示符
"%LOCALAPPDATA%\MirrorFastlane\set-hook-token.cmd"

:: PowerShell 提示符（PS C:\...>）
& "$env:LOCALAPPDATA\MirrorFastlane\set-hook-token.cmd"

:: 脚本在下载文件夹等任意位置：双击 .cmd，或直接指定 .ps1 的实际路径
powershell -NoProfile -ExecutionPolicy Bypass -File "<脚本所在目录>\set-hook-token.ps1"
```

`.cmd` 必须与 `set-hook-token.ps1` 同目录；只用 `.ps1` 也能独立运行。其他参数（同样可跟在 `.cmd` 后）：`-FromClipboard`（从剪贴板取 PAT，不进命令行历史）、`-NoVerify`（跳过联网自检）、`-Show`（只看解析出的路径与状态，不显示 token）、`-Remove`（删除凭据，退回环境变量）、`-TokenFile <路径>`（显式指定，但与 hook 目录不同时会警告）。

只想用环境变量也行：`setx GITHUB_TOKEN <token>`；删除请用 `[Environment]::SetEnvironmentVariable('GITHUB_TOKEN', $null, 'User')`，别用 `setx VAR ""`（会留下空值）。注意环境变量会进入之后所有新进程的环境块，暴露面比凭据文件大，所以默认优先凭据文件。

安全说明：token 只进 `Authorization` 头，绝不写日志、`outbox.txt` 或通知；建议用无写权限 scope 的只读 PAT。DPAPI 密文绑定当前 Windows 用户，换用户或重装系统后需重新运行工具。

这份配置存在 `HKCU\Software\DownloadManager` 的两个值里：`VScannerProgram`（解释器）与 `VScannerParameters`（参数）。随时可以自检：

```powershell
npm run check:idm
```

它会核对解释器是否存在、`-File` 指向的脚本是否存在、脚本哈希是否与基线一致、`[File]` 有没有被弄丢，并特别检查**值尾部有没有多余换行** —— 从聊天窗口复制路径时极易带上，而带换行的路径调用 CreateProcess 会直接 ENOENT，表现为「配置看着正常但钩子从不触发」。

建议把脚本放在 `%LOCALAPPDATA%\MirrorFastlane\` 而不是仓库目录 —— 仓库移动或重新 clone 不影响挂载；更新脚本时覆盖过去，再跑一次 `check-integrity.ps1` 确认基线一致。
