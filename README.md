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
node build.mjs          # 产出 dist/edge、dist/firefox、dist/debug（debug 仅本机排查用）
```

- Edge / Chrome：`edge://extensions` 或 `chrome://extensions` → 打开「开发者模式」→「加载解压缩的扩展」→ 选 `dist/edge`
- Firefox：`about:debugging` → 「此 Firefox」→「临时载入附加组件」→ 选 `dist/firefox/manifest.json`

> Chrome 156 起不再支持 `--load-extension` 命令行开关，命令行加载请用 Edge 或 Chrome for Testing。
>
> 根目录的 `manifest.json` 是构建模板（同时声明 `service_worker` 与 `scripts`），**不要直接把仓库根目录当成「加载解压缩的扩展」**；请始终选 `dist/edge` 或 `dist/firefox`。

## 权限说明

| 权限 | 用途 |
|---|---|
| `storage` | 保存镜像列表与设置，仅存本机 |
| `alarms` | 定时探测（仅在开启「定时」模式时使用） |
| `declarativeNetRequest` | 改写下载地址 |
| `host_permissions: github.com / codeload.github.com` | 改写目标与发起方 |
| `downloads` | 写校验任务文件；监听下载中断，用于镜像降权 |
| `optional_host_permissions` | 每个镜像域名单独申请，安装时不索取 |
| `optional_permissions: webRequest` | 默认不申请；开启 raw 时在用户手势里申请，只观察 raw 请求的 URL 与状态码，不阻断、不读内容 |

镜像域名用「可选权限」而非全量权限：安装时不弹授权，添加或批量授权时才请求，且只针对具体域名。

## 镜像清单

内置清单在 `data/builtin-mirrors.json`，按实测速度排序。远程清单默认关闭，开启后按下面的顺序回退：

```
内置清单 → 经镜像拉远程 JSON → 直连拉远程 JSON → 保留上次缓存
```

远程 JSON 只当数据解析，字段白名单校验（只接受 https），**不会执行任何远程代码**。

### 清单会自动更新

`data/builtin-mirrors.json` 由 GitHub Actions 每天按 `git.mxg.pub` 的成功列表更新（见
`.github/workflows/update-mirrors.yml` + `tools/refresh-mirrors.mjs`）。规则是 **「手工精选 ∪ 源当前 success」**：

- **没有 `auto` 字段**的条目是手工精选（那 10 个实测较快的镜像），脚本**永不删**；
- 其余部分**整段按源当前的 success 覆盖**（顺序与地址都跟源走）：新地址直接顶掉旧地址，旧地址只要不在这次 success 里就消失，条目用 `auto: true` 标出——这正是扩展侧「连续 24h 缺失才移除」的输入；
- 源解析后为空或全部失败时，脚本**直接报错退出**，不覆盖文件。

为什么不整份替换：源的可用集与本项目自测的内置集几乎不重叠，整份替换会冲掉实测更快的镜像。

### 列表会自己增删吗

开了远程清单后，设置页有「允许删除镜像」开关（默认开）：

- **远程清单加进来的镜像**：连续 24 小时不在成功列表里才移除（相邻两次观测间隔超过 48 小时视为离线，重新计时，不误删）；
- **内置镜像**：永不因缺失删除——源没测它不等于它挂了，只会被扩展自身探测降权、不再被选中；
  **启动 / 升级时会补齐内置清单里缺失的条目**（老用户不会再停在安装时的旧快照）；你手动删掉的内置镜像会被记下来，不会复活；
- **手动添加的镜像**：永不自动删除；
- **抓取失败 / 清单格式不认识 / 清单为空**：这一轮不做缺失判定，一个镜像都不会删（只有在拿到一份非空且能识别的清单时才会累计缺失时间）。

### 授权（只影响测速，不影响跳转）

跳转本身不需要**可选 host 权限**（Firefox 实测：一个镜像域名都没授权时 release 的改写照样生效），**不授权也能正常用**，只是没法测速排序。
但浏览器层面的「站点访问 / 全部网址」总开关若被关掉，扩展对任何站点的请求都会被隔离，改写也不会发生——那是浏览器设置，不是本扩展的权限。设置页有两个批量授权按钮：

- **一键授权内置镜像**——只覆盖内置的那几个；
- **授权远程镜像**——只授权**此刻已经在列表里**的远程镜像（来源列显示「远程」）。之后清单自动新增的**不会**跟着被授权，因为浏览器只允许在用户点击的当下申请权限；想授权新来的，再点一次即可。

授权后一律以浏览器的 `permissions.contains` 为准回填状态，不会再出现「显示已授权但测不了」。

### 规则怎么生成

DNR 里**一个请求只会命中一条规则**，规则之间不存在"这个失败了再试下一个"的链式回退。
所以扩展不再给每个镜像都建一条永远轮不到的规则，只给真正会被用到的目标建：

| 规则 | 目标 | 开启条件 |
|---|---|---|
| 直链 `releases/download/…` | 得分最高的健康镜像 | 总是 |
| 源码包 `codeload.github.com/…` | 分流开启时换**第二个**健康镜像；关掉则同直链 | 设置里勾选「源码包」 |
| raw 单文件 `raw.githubusercontent.com/…` | 按 **raw 自身**的延迟排序，取前 5 个健康镜像，按 owner 首字符分 5 组各走一个 | **默认关**：设置页勾选一次，浏览器会弹权限确认 |

**为什么 raw 要单独一套**：大文件的吞吐排名和小文件的延迟排名不是一回事，混在一起会让某一类变慢；
分成 5 片则是为了避免所有 raw 请求挤在同一个镜像上被限流——代价是某一片挂了，只有约 1/5 的 raw 地址会失败。

**raw 规则只作用于 `main_frame`**（直接打开链接 / 下载），不动 `xmlhttprequest` 与 `image`：
镜像返回的 CORS 头与 GitHub 不同，改页面里的 fetch 会把原本能用的请求弄坏；图片则会让一个页面产生几十个
小请求打镜像，既容易触发限流又可能更慢。

**raw 需要一次可选授权**：Chromium 只对「扩展拥有 host 权限的请求 URL」应用 redirect。
`raw.githubusercontent.com` 属于 `optional_host_permissions`，所以勾选开关时浏览器会弹一次确认；
没拿到授权时扩展**不生成** raw 规则，避免注册一堆永不生效的规则。拒绝授权不影响 release/源码包。

同一手势里还会一并申请**当前 raw 分片用到的镜像域名**与可选的 `webRequest` 观察权限：
实测只给 raw host 权限时，被改写到镜像的请求只有「发起」、看不到「结果」，失败率就算不出来。
分片变化后可用设置页的「补授权 raw 分片」补一次；
`webRequest` 是可选项，某些浏览器不支持运行时申请时，raw 加速照常工作，只是没有失败率统计。

「直链与源码包分走不同镜像」默认开启：两类流量来自不同源站、体量也差一个量级，分开跑避免互相挤占，
也避开单个镜像的限流。只有一个可用镜像时自动退化成同一个。

代价要说清楚：**分流不等于故障转移**。某个镜像在两次探测之间挂掉，已生成的规则仍指向它。
现在有三条自愈路径：真实下载中断会自动给它降权并重建规则、raw 失败率超阈值会立刻重测分片、
也可以点弹窗「换镜像」或设置页「立即测速全部」手动切换。

### 失败自愈、探测预算与可观测性

- **真实下载失败**：`downloads.onChanged` 里的 `interrupted`（排除用户取消、关机、浏览器崩溃）会给对应镜像记一次故障并重建规则，自动换到下一个健康镜像；同一镜像 10 分钟内只记一次，避免失败风暴。
- **raw 请求失败率**：开启 raw 后统计最近 30 分钟**真实 raw 请求**的成败（只看 URL 与状态码，不读内容、不阻断）。404/410 是「文件真的不存在」，不计成败；429/5xx 才算镜像故障。失败占比达到阈值（默认 30%，至少 5 个样本）会**立刻重测 raw 分片并重排 top 5**，随后进入冷却（默认 5 分钟）。样本只存本机 storage，不上传。
  - 观测不到结果的请求（多为分片域名还没授权）记为「无法观测」，**不计入分母**，避免把「看不见」误判成「失败」；设置页能看到这个数字并一键补授权。
- **探测预算**：单次探测 256 KB → 64 KB；按时 / 按需探测跳过 `probeCacheHours`（默认 2 小时）内已测过且健康的镜像，按「最久没测」轮转、每轮最多 6 个，并发从 3 提到 6（17 条全量的轮数 6 → 3，慢镜像不再逐个排队）。**坏镜像每轮只占 1 个名额**（最久没测的那个），既不让它们拖慢整轮，又保留恢复健康的机会；探测失败时**保留上次测得的速度**，单次抖动不会把好镜像清零。手动「立即测速全部」仍测全部。
- **判定修正**：200 的 HTML 错误页、只读到几百字节都不再算健康；超时但已读够 8 KB 算「部分成功」（速度偏低自然降权），不再一律判死。
- **规则失败可见**：`updateDynamicRules` 抛错时徽章变 `!`、设置页显示红字，不再停在上一次的「生效中」。
- **少唤醒**：没开「生效时段」时不创建 5 分钟 tick；SW 每次唤醒用规则指纹比对，规则没变就不做 DNR 全删全加。
- **并发写入**：镜像表的所有读-改-写排队；探测跑几十秒后按**最新**列表合并探测字段，用户在这期间的停用 / 删除不会被静默回滚（真浏览器回归测试里守着这条）。
- **看得见的数据**：清单里的 `note`（如「IDM 建议 4 连接」）与 `seedKbps` 现在会显示在镜像列表；「诊断」区可导出一份脱敏 JSON 快照（Token 打码），正式包也能自查。
- **一键自检**：「诊断」区能跑一次自检，按 OK / WARN / FAIL 列出规则、权限、可用镜像、storage、远程清单与最近探测，结果可一键复制。
- **权限被拒可自救**：申请失败、或「已开启但权限被撤销」时，设置页会直接给出下一步路径（Firefox：`about:addons` → 权限 → 访问网站；Chromium：扩展详情页 → 站点访问权限），并可复制该地址。
- **双语**：设置页的状态、按钮、表头与关键提示走 `_locales`（中 / 英），正文说明保持中文；远程清单**默认仍关闭**——内置镜像开箱可用。

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

**IDM**：IDM 没有通用的「下载完成后运行程序」选项，唯一可用的钩子是「病毒检查」那一栏（官方文档明确：
下载完成时用 `[File]` 替换成文件路径去 CreateProcess）。设置路径：

1. 选项 → 「下载」标签页 → 「病毒检查设置」→ 编辑
2. 程序填 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
3. 参数填（路径换成你自己的，`[File]` 原样保留）：

   ```
   -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%LOCALAPPDATA%\MirrorFastlane\hash-hook.ps1" "[File]"
   ```

4. 确定保存

解释器用哪个都行，实测同一脚本（含目录探测）的启动开销：

| 解释器 | 路径 | 中位耗时 |
|---|---|---|
| Windows PowerShell 5.1 | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` | 558 ms |
| scoop 的 pwsh 7 | `…\scoop\apps\pwsh\current\pwsh.exe` | 606 ms |
| scoop 的 shim | `…\scoop\shims\pwsh.exe` | 651 ms |

推荐 5.1：系统自带、路径恒定、最快，不受包管理器状态影响。若坚持用 scoop 的 pwsh，
填 `apps\pwsh\current\pwsh.exe`——`current` 是 junction，升级后仍指向新版本；
不要填 `shims\pwsh.exe`，那是多一层转发，慢 45 ms，且 scoop 重装时会重建。
代价是：scoop 卸载、迁移盘符或 `current` 重建期间，IDM 的钩子会静默失败（IDM 只记一条 CreateProcess 错误）。

IDM 会对**每一次**下载完成都调用它，脚本靠任务文件区分：没有对应任务的（非 GitHub 下载）静默退出，不弹通知、不写记录。

### 回源凭据（可选，建议配）

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

这份配置存在 `HKCU\Software\DownloadManager` 的两个值里：`VScannerProgram`（解释器）与 `VScannerParameters`（参数）。
随时可以自检：

```powershell
npm run check:idm
```

它会核对解释器是否存在、`-File` 指向的脚本是否存在、脚本哈希是否与基线一致、`[File]` 有没有被弄丢，
并特别检查**值尾部有没有多余换行**——从聊天窗口复制路径时极易带上，而带换行的路径调用 CreateProcess 会
直接 ENOENT，表现为「配置看着正常但钩子从不触发」。
建议把脚本放在 `%LOCALAPPDATA%\MirrorFastlane\` 而不是仓库目录——仓库移动或重新 clone 不影响挂载；
更新脚本时覆盖过去，再跑一次 `check-integrity.ps1` 确认基线一致。

失败回调再加 `-Status fail`。脚本读取本地文件、计算 SHA-256、把结果写入 `outbox.txt` 并弹通知；
此外**默认向 `api.github.com` 发一次只读 GET 回源复核官方 digest**（可用 `-NoNet` 完全关闭联网，
回源凭据见上文「回源凭据」一节）。它不上传文件内容、不执行下载内容、不扫描任务目录之外的文件。

通知按以下顺序降级，任一成功即可：BurntToast 模块 → WinRT Toast（PowerShell 5.1）→ 托盘气泡。
三者都不可用时静默跳过，不影响校验与 outbox 记录。

## 测试

```bash
npm test                       # 全套（build + 以下 7 组）
node test/run-tests.mjs        # 纯逻辑 + 清单完整性 + 合规扫描 + 发布防呆（278 项）
node test/debug-log-test.mjs   # 调试日志并发写入与脱敏（4 项）
node test/content-state-test.mjs # 内容脚本状态刷新（7 项）
node test/refresh-mirrors-test.mjs # 清单刷新脚本：精选保留 / 整段覆盖 / 空源拒绝（30 项）
node test/browser-smoke.mjs    # 真浏览器加载扩展，校验规则/设置页/校验页（42 项）
node test/redirect-check.mjs   # 端到端：github 链接确实被 302 到镜像（10 项）
node test/taskfile-e2e.mjs     # 端到端：扩展写出的校验任务文件内容正确（18 项）
node test/run-ps-tests.mjs     # 脚本逻辑（79 项断言，自动找 pwsh / powershell）
npx --yes web-ext lint --source-dir dist/firefox   # Firefox 上架前静态检查
```

node test/verify-release-test.mjs # 发版体检自身的回归（8 项，纯临时目录）

单元测试 278 项、脚本测试 79 项，其余 119 项（debug 日志 4 + 内容脚本 7 + 清单刷新 30 + 冒烟 42 + 改写 10 + 任务文件 18 + 发版体检 8），合计 **476 项**。

`test/run-ps-tests.mjs` 会自动找 `pwsh` 或 `powershell`，在临时目录里跑完全部用例：

```
任务+子文件夹 / 期望值不一致 / 无期望值 / 重命名副本 (1) / 多副本取最新 /
旧文件不误判 / 覆盖同名 / 过期任务清理 / aria2 显式路径 / 失败回报 /
跨目录配对 / 多任务并发 / 不误处理内部文件 / 回源复核开关 / 字节数锚点 /
来源合成 / 回源边界 / 脚本完整性自检 / 非 GitHub 下载不打扰
```

`test/probe-*.mjs` 是针对浏览器能力的一次性探测脚本（下载协议兼容性、IDM 是否劫持、扩展能否写文件），
会往真实下载目录写测试文件，不属于常规测试，请勿在无关环境运行。

## 维护与自动化

- `npm run sync:store-readme`：打包后从 `build-info.json` 自动把三个包的体积与 SHA-256 写进 `store/README.md`，不用再手抄。
- `npm run check:release`（`tools/verify-release.mjs`）：发版前一键体检——版本一致性、三个 zip 的完整性与 SHA-256、`store/README.md` 哈希、源码包不含 `dist/docs/store/archive`、正式包调试日志为 stub。
- `npm run check:mirrors`（`tools/validate-mirrors.mjs`）：清单 schema 门禁；`update-mirrors.yml` 在 bot 提交前也会跑，坏清单进不了 main。
- `.github/workflows/test.yml`：push / PR 跑纯 Node 测试（构建、逻辑单测、schema、发版体检回归）+ **headless Chrome 真浏览器冒烟**（42 项，不访问外网）。只有依赖真实网络与 PowerShell 的测试仍在本机跑。

## 提交到商店

两个商店都要求「无远程代码 + 可审查的源码」，这里的交付方式是一致的：

| 商店 | 提交什么 | 说明 |
|---|---|---|
| Edge Add-ons | `dist/edge` 打成的 zip | 隐私政策 URL 用本仓库 `privacy.md`；权限说明见上表 |
| Firefox AMO | `dist/firefox` 打成的 zip | manifest 已声明 `data_collection_permissions.required: ["none"]`；源码即本仓库，必要时可在 AMO 里指定"源码在仓库" |

打包（不依赖第三方工具）：

```powershell
npm run store       # build + logo + 截图 + 打包，一步生成 store/packages/ 下三个 zip
npm run pack        # 只重新打包（不重拍截图）

# 也可手工打包（不依赖脚本自带的 zip 实现）：
Compress-Archive -Path dist\edge\*    -DestinationPath mirror-fastlane-edge-1.4.11.zip -Force
Compress-Archive -Path dist\firefox\* -DestinationPath mirror-fastlane-firefox-1.4.11.zip -Force
```

`hooks/` 不在扩展包里——它是可选增强，单独作为 release 资产发布，
设置页里链接到 release 页，用户自己下载并审查。

**本地化**：`name` / `description` / `action.default_title` 走 `_locales`（`en` 与 `zh_CN`），
`default_locale: en`。这是商店识别「可选语言」的依据——没有 `_locales` 目录时，
Edge 只会认出 English (United States) 一种，无法添加简体中文的商店文案。
界面文案（设置页、校验页）目前仍是中文单语，只有名称与简介随浏览器语言切换。

**扩展 ID 已定稿**：`mirror-fastlane@morangsu.github.io`（与 `zenith-newtab@morangsu.github.io` 同一命名约定，
即 `<仓库名>@morangsu.github.io`）。AMO 首次提交后 id 不可更改，提交前请不要再动它。

## 隐私

见 [privacy.md](./privacy.md)。

## 许可

MIT
