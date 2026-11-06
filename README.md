# 镜像快车道

把 GitHub 的下载链接自动切换到可用镜像，并在页面上标明替换来源。

支持 Microsoft Edge / Google Chrome / Mozilla Firefox（Manifest V3）。

## 它做什么

- 用 `declarativeNetRequest` 在网络层把 `github.com/*/releases/download/*` 改写为镜像地址
- 可选的 `codeload.github.com/*` 源码包改写（默认关闭）
- 页面上给下载链接加「镜像」角标，点击后提示走了哪个镜像（可分别关闭）
- 管理页可以查看、添加、删除、测速镜像；镜像域名按需单独授权
- 探测策略默认「仅按需」：只有你打开 GitHub 页面时才测速，避免浪费镜像流量
- 支持生效时段（如 20:00–02:00），时段外不探测、不改写，全部回退主站
- 哈希校验（默认关闭）：从 GitHub 取期望值，比对本地文件；可开启全自动比对与系统通知，脚本还会回源复核哈希来源

## 它不做什么

- 不代理网页浏览，不是 VPN，不改变你的出口 IP
- 不缓存内容，不收集任何使用数据
- 不改写浏览器之外的请求（例如你直接往下载器里粘贴原链）

## 安装（开发者模式）

```bash
node build.mjs          # 产出 dist/edge 与 dist/firefox
```

- Edge / Chrome：`edge://extensions` 或 `chrome://extensions` → 打开「开发者模式」→「加载解压缩的扩展」→ 选 `dist/edge`
- Firefox：`about:debugging` → 「此 Firefox」→「临时载入附加组件」→ 选 `dist/firefox/manifest.json`

> Chrome 156 起不再支持 `--load-extension` 命令行开关，命令行加载请用 Edge 或 Chrome for Testing。

## 权限说明

| 权限 | 用途 |
|---|---|
| `storage` | 保存镜像列表与设置，仅存本机 |
| `alarms` | 定时探测（仅在开启「定时」模式时使用） |
| `declarativeNetRequest` | 改写下载地址 |
| `host_permissions: github.com / codeload.github.com` | 改写目标与发起方 |
| `optional_host_permissions` | 每个镜像域名单独申请，安装时不索取 |

镜像域名用「可选权限」而非全量权限：安装时不弹授权，添加或批量授权时才请求，且只针对具体域名。

## 镜像清单

内置清单在 `data/builtin-mirrors.json`，按实测速度排序。远程清单默认关闭，开启后按下面的顺序回退：

```
内置清单 → 经镜像拉远程 JSON → 直连拉远程 JSON → 保留上次缓存
```

远程 JSON 只当数据解析，字段白名单校验（只接受 https），**不会执行任何远程代码**。

### 规则怎么生成

DNR 里**一个请求只会命中一条规则**，规则之间不存在"这个失败了再试下一个"的链式回退。
所以扩展不再给每个镜像都建一条永远轮不到的规则，只给真正会被用到的目标建：

| 规则 | 目标 | 开启条件 |
|---|---|---|
| 直链 `releases/download/…` | 得分最高的健康镜像 | 总是 |
| 源码包 `codeload.github.com/…` | 分流开启时换**第二个**健康镜像；关掉则同直链 | 设置里勾选「源码包」 |

「直链与源码包分走不同镜像」默认开启：两类流量来自不同源站、体量也差一个量级，分开跑避免互相挤占，
也避开单个镜像的限流。只有一个可用镜像时自动退化成同一个。

代价要说清楚：**分流不等于故障转移**。某个镜像在两次探测之间挂掉，已生成的规则仍指向它，
要等健康度翻转（连续 3 次探测失败）才会重建规则。想立刻切换，去设置页点「立即测速全部」。

## 哈希校验（可选）

默认关闭。开启后有两种用法：

| 用法 | 需要什么 | 体验 |
|---|---|---|
| **自动校验**（推荐） | 设置页开「哈希校验」+「下载时写校验任务」，再把脚本挂到下载器 | 下载完成自动比对并弹系统通知 |
| **手动校验** | 什么都不用配 | 校验页填地址取期望值 → 选文件算实际值 |

### 自动校验的链路

```
你在 GitHub 点下载
   └→ 扩展取期望哈希，写成 _mfl-tasks/<文件名>.task.json（落在浏览器下载目录）
下载器把文件下到磁盘（可以是任意子文件夹）
   └→ 下载器回调运行 hash-hook.ps1
        └→ 脚本自己找到下载目录 → 找到任务文件 → 按文件名找到下载文件
             └→ 算 SHA-256 → 与期望值比对 → 弹系统通知 → 写 outbox.txt → 删任务文件
```

**扩展只负责写一个 JSON，不读磁盘、不轮询、不弹通知。** 校验与通知全部由脚本完成，
所以这套在 Edge / Chrome / Firefox 上都能用，也不需要任何目录授权。

### 非 GitHub 的下载会被忽略

下载器对**每一次**完成都会回调脚本，其中大半是从别的站下的文件。脚本靠任务文件区分：

| 情况 | 脚本行为 |
|---|---|
| 有同名任务文件（扩展接管的 GitHub 下载） | 校验并通知 |
| 有任务文件但文件名对不上 | 不处理那个文件（任务留给它自己的下载） |
| 没有任务文件（非 GitHub 或绕过扩展的下载） | **静默退出**：不弹通知、不写记录、不算哈希 |
| 想只算一下最新下载文件的哈希 | 手动加 `-ScanRecent`，此时只报本地值，徽章为「仅本地值」，绝不判通过 |

这样挂到 IDM 上之后，下载普通文件不会再被"已计算哈希"打扰，也不会把无关文件混进校验历史。

### 脚本会自动找下载目录

不传 `-DownloadDir` 时，脚本依次探测并去重（含符号链接还原）：

```
Chrome / Edge / Brave / Chromium / Vivaldi 各 Profile 的 download.default_directory
Firefox 各 Profile 的 browser.download.dir
IDM 的 LocalPathW
系统「下载」已知文件夹
```

浏览器下载目录与 IDM 目录不同时，脚本会把两边都扫一遍。

### 下载文件在子文件夹里也没问题

IDM 默认按类型分类存放（`Archives/`、`Programs/`、`Documents/`、`Images/`、`Videos/`…）。
脚本递归查找，只跳过 `_mfl-tasks` 自身和临时文件（`.part` / `.dwl` / `.aria2` 等）。

### 判定规则

一个任务只有**同时满足**下面条件才会被比对：

1. 任务文件里的 `name` 能在下载目录里找到对应文件
2. 文件能读出 SHA-256
3. 任务文件里带了 `expected`（没带就只报告本地哈希，不判定）

`expected` 的来源优先级：API 的 `digest` → 边车 `.sha256` → `SHA256SUMS` 类清单 → release 正文。
老仓库可能一个都没有，此时脚本只报「已计算哈希」。

### 哈希来源可信度

任务文件是下载目录里一个普通 JSON，**任何能写那个目录的程序都能改它**。
所以脚本不是"读 `expected` 然后比对"就完事，而是分三层看：

| 层 | 由谁提供 | 主要防什么 |
|---|---|---|
| 官方摘要 | `api.github.com` 对该资产的 `digest` | 镜像 / CDN 投毒、缓存串味、续传拼错 |
| 来源锚点 | 任务文件的 `repo` / `tag` / `assetId` / `size` | 任务文件被改：脚本拿锚点自己回源问一次 |
| 内容哈希 | 本地文件的 SHA-256 | 传输损坏、落地后被替换 |

判定口径：

| 情况 | 结论 |
|---|---|
| 任务文件的 `expected` ≠ 官方 `digest` | **报「哈希来源被改动」，不判通过**（冲突时拒绝采信，而不是二选一） |
| 官方只有边车 / 清单 / 正文里的哈希（无 `digest`） | 照常比对，但只算单源，不标"已回源" |
| 回源失败、限流、离线 | 降级为「仅凭任务文件通过」，通知与记录里写明原因 |
| 资产字节数与本地文件不符 | 单独提示「大小异常」（同名不同物） |

`outbox.txt` 第 5 段记录可信度，校验页会显示徽章：`已回源复核` / `未复核` / `来源冲突` / `仅本地值`。
旧格式（4 段）仍然能读，只是没有徽章。

#### 同名资产、多个版本怎么区分

同一仓库的不同 release 常放同名文件（`foo.zip` 每个版本放一个），同一个 release 里也可能并列多个版本
（`foo-1.0.0.zip` / `foo-1.1.0.zip`）。三道闸门：

1. **URL 里的 tag**：`/releases/download/v1.0.0/foo.zip` 的 tag 必须解析出来。丢掉它就会退化成「查最新版」，
   然后拿新版的哈希去比老版本的文件——1.3.1 修的就是这个（之前 `download` 形态的 tag 被丢弃了）。
2. **资产 id**：任务文件里带 `assetId`（数字，永不变）。回源时直接 `GET /releases/assets/<id>`，
   同名也认不错；只有按 id 查不到（资产被删）才退到「按 tag 找 release、按名字找资产」。
3. **拒绝猜**：粘 release 页面而该 release 有多个资产时直接报错，要求给具体文件的直链，
   不会把某个资产的哈希安到目标文件头上。

| 你给的东西 | 能定位到什么 |
|---|---|
| `…/releases/tag/v1.0.0` 且该 release 只有 1 个资产 | 该资产 |
| `…/releases/tag/v1.0.0` 且有多个资产 | 报错，要求直链 |
| `…/releases/download/v1.0.0/foo.zip` | 精确到 tag + 文件名，回源再精确到 assetId |
| `…/releases/latest/download/foo.zip` | 最新 release 里的 foo.zip |

完全不想联网：给脚本加 `-NoNet`，回源整段跳过，行为退化成"只信任务文件"并如实标注。

#### 它挡不住什么（别高估）

- **本机已被入侵**：攻击者既能改下载文件，也能改任务文件，还能改脚本本身。写死在本地的密钥没有意义——扩展是公开代码，不存在秘密。这种情况只能靠离线核对（另一台机器、或对照上游签名）。
- **上游自己出错或作恶**：`digest` 只证明"你拿到的是作者上传的那份字节"，不证明"那份是安全的"。
- **脚本被替换**：把 `hooks/hash-hook.ps1` 留在 git 仓库里，用 `git status` / `git diff` 对照上游，是最省事的一次性完整性检查。
- **本地代理做了 TLS 中间人**：代理能改写 `api.github.com` 的响应，回源复核随之失效。装过可疑根证书的机器上，不要把这条链当强保证。

一句话：这套机制保证的是**"镜像没骗你"**，不保证**"这台机器没被攻破"**。

### 脚本本身的完整性

回源复核再严，前提是**跑的那份脚本没被换过**。给 `hooks/hash-hook.ps1` 配了一个自检：

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

- **只有基线不一致** → 文件被改过，但基线还是仓库里的原值
- **基线不一致 + git 报改动** → 连基线一起被改了，或者是你自己改完没提交

退出码：`0` 一致 / `1` 不一致 / `2` 缺基线。**改了脚本不提交，自检就会一直报红**——这是故意的，提交本身就是"我确认过这次改动"的记录。

> 之所以不走 Authenticode 签名：自签的根证书装在本机信任库里，有管理员权限的东西可以装自己的证书重签，你看到的仍是"签名有效"；而 `.ps1` 的签名只有执行策略设为 `AllSigned` 时才被检查，`RemoteSigned` 下等于没有。真要签，得用 CA 签发的代码签名证书（SignPath 对开源免费、Azure Trusted Signing 约 $9.99/月），代价与收益对个人脚本不划算。

### 跨浏览器的差异

`downloads.download()` 对 URL 协议的要求在两个内核上相反，实现里已分别处理：

| | `data:` URL | `blob:` URL |
|---|---|---|
| Chromium（Service Worker） | ✅ 可用 | ❌ 没有 `URL.createObjectURL` |
| Firefox（Event page） | ❌ `Access denied for URL data:` | ✅ 可用 |

### 重复下载同一个文件

IDM 遇到同名文件会提示，两种选择脚本都认：

| 你的选择 | 磁盘上的结果 | 脚本怎么找 |
|---|---|---|
| **覆盖** | 还是 `foo.zip`，但修改时间更新 | 选它 |
| **重命名** | `foo (1).zip` / `foo (2).zip` | 认这个副本编号，取最新的那个 |

判据是「文件名匹配（含副本编号）**且**修改时间不早于任务创建时间」。所以：

- 之前下过的旧文件不会被误选（时间早于任务，直接跳过）
- 新的副本或覆盖后的文件会被选中
- 用户取消下载时，任务文件留着等 30 秒，之后按过期处理

任务文件本身不会因为重命名而堆积——IDM 重命名的是下载的文件，扩展写的任务文件始终是 `<原文件名>.task.json`，重复下载时直接覆盖。

如果有人把文件改成了完全无关的名字，脚本就找不到了，这种情况用校验页手动校验。

### 目录整洁

所有中间产物都在下载目录下的 `_mfl-tasks\` 里，下载根目录只有你下载的文件：

```
下载目录\
├── Archives\  Programs\  Documents\ …     ← 你的文件（IDM 分类）
└── _mfl-tasks\
    ├── foo.zip.task.json                  ← 待校验任务，用完即删
    └── outbox.txt                         ← 校验历史（保留最近 200 条 / 7 天）
```

- 任务文件：校验完成后立即删除；超过 7 天未处理的会在下次运行时清掉
- `outbox.txt`：自动裁剪，不需要手动维护
- 整个 `_mfl-tasks` 目录可以直接删，下次运行会重建

### 查看历史

校验结果写在 `_mfl-tasks\outbox.txt`。在校验页授权下载根目录即可查看（脚本会先找 `_mfl-tasks`，
找不到再兼容旧版写在根目录的 `outbox.txt`）。纯展示用途，不授权也不影响自动校验。

### 边界

- 扩展只能把任务文件写进**浏览器自己的下载目录**（`downloads` API 的硬边界，越界路径一律拒绝）
- 直接往下载器里粘贴 GitHub 链接（不经过页面点击）不会产生任务文件，这种用校验页手动校验
- Firefox 的下载目录若与 IDM 目录不同，脚本会两边都扫，但任务文件只落在浏览器那边

### 脚本挂载方式

**这个脚本不在扩展包内，需要你自己下载。** 使用前请阅读源码并自行审查其安全性与可靠性；作者仅保证它在开发者本人的设备上可用，不对其他环境作任何承诺。

- aria2 / Motrix / Gopeed：把脚本挂到「下载完成」与「下载失败」回调
- IDM：选项 → 下载完成后运行程序，填

  ```powershell
  pwsh -NoProfile -ExecutionPolicy Bypass -File "…\hash-hook.ps1"
  ```

  （没装 PowerShell 7 的话，把 `pwsh` 换成 `powershell` 也能跑，脚本向下兼容 5.1）

失败回调再加 `-Status fail`。脚本只做三件事：读本地文件、算 SHA-256、写一行文本 / 弹一条通知。
不联网、不上传、不执行下载内容。

通知按以下顺序降级，任一成功即可：BurntToast 模块 → WinRT Toast（PowerShell 5.1）→ 托盘气泡。
三者都不可用时静默跳过，不影响校验与 outbox 记录。

## 测试

```bash
node test/run-tests.mjs        # 纯逻辑 + 清单完整性 + 合规扫描（118 项）
node test/browser-smoke.mjs    # 真浏览器加载扩展，校验规则/设置页/校验页（23 项）
node test/redirect-check.mjs   # 端到端：github 链接确实被 302 到镜像（8 项）
node test/taskfile-e2e.mjs     # 端到端：扩展写出的校验任务文件内容正确（18 项）
node test/run-ps-tests.mjs     # 脚本逻辑：19 组用例、57 项断言（调用 PowerShell 跑）
npx web-ext lint --source-dir dist/firefox   # Firefox 上架前静态检查
```

单元测试 148 项、脚本测试 57 项，合计 **254 项**。

`test/run-ps-tests.mjs` 会自动找 `pwsh` 或 `powershell`，在临时目录里跑完 19 组用例：

```
任务+子文件夹 / 期望值不一致 / 无期望值 / 重命名副本 (1) / 多副本取最新 /
旧文件不误判 / 覆盖同名 / 过期任务清理 / aria2 显式路径 / 失败回报 /
跨目录配对 / 多任务并发 / 不误处理内部文件 / 回源复核开关 / 字节数锚点 /
来源合成 / 回源边界 / 脚本完整性自检 / 非 GitHub 下载不打扰
```

`test/probe-*.mjs` 是针对浏览器能力的一次性探测脚本（下载协议兼容性、IDM 是否劫持、扩展能否写文件），
会往真实下载目录写测试文件，不属于常规测试，请勿在无关环境运行。

## 提交到商店

两个商店都要求「无远程代码 + 可审查的源码」，这里的交付方式是一致的：

| 商店 | 提交什么 | 说明 |
|---|---|---|
| Edge Add-ons | `dist/edge` 打成的 zip | 隐私政策 URL 用本仓库 `privacy.md`；权限说明见上表 |
| Firefox AMO | `dist/firefox` 打成的 zip | manifest 已声明 `data_collection_permissions.required: ["none"]`；源码即本仓库，必要时可在 AMO 里指定"源码在仓库" |

打包（不依赖第三方工具）：

```powershell
npm run build
Compress-Archive -Path dist\edge\*    -DestinationPath mirror-fastlane-edge-1.4.1.zip -Force
Compress-Archive -Path dist\firefox\* -DestinationPath mirror-fastlane-firefox-1.4.1.zip -Force
```

`hooks/` 不在扩展包里——它是可选增强，单独作为 release 资产发布，
设置页里链接到 release 页，用户自己下载并审查。

**扩展 ID 已定稿**：`mirror-fastlane@morangsu.github.io`（与 `zenith-newtab@morangsu.github.io` 同一命名约定，
即 `<仓库名>@morangsu.github.io`）。AMO 首次提交后 id 不可更改，提交前请不要再动它。

## 隐私

见 [privacy.md](./privacy.md)。

## 许可

MIT
