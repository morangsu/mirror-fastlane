# 评估：不改默认清单地址，让镜像清单自动更新

> 日期：2026-11-08　|　对象：mirror-fastlane 的 `remoteList.url` = `https://raw.githubusercontent.com/morangsu/mirror-fastlane/main/data/builtin-mirrors.json`
> 结论先行：**技术上完全可行，但不是「重定向」，而是「自动化改写这个文件的内容」**；且有一个必须先解决的坑——`remoteList.enabled` 默认是 **false**，光改文件不会影响已装用户。
> **本文是内部设计与评审记录，不会进 AMO 源码包**（`tools/pack.mjs` 已排除 `docs/`）。

---

## 0. 结论速览

| 问题 | 回答 |
|---|---|
| 能否把 URL「指向」别的可用性检测项目？ | raw.githubusercontent 是静态文件、**不能 302 重定向**。只能把对方数据**转译/聚合后写进同一个文件**。 |
| 能否部署服务来更新这个？ | 可以。**GitHub Actions 定时任务**（零服务器）最合适；外部 serverless/VPS 亦可。 |
| 存量用户能自动吃到更新吗？ | **不能**（remoteList 默认关）。需**发一次版**把 `remoteList.enabled` 默认改 true（不动 URL），或让用户手动开。 |
| 现成可用性接口？ | 实测 `https://git.mxg.pub/api/github/list` → `{data:[{name,url,status,latency}]}`（14 条 / 7 成功），但偶发超时，需容错。 |

---

## 1. 现状事实（读代码得出）

- **两份清单**：
  1. 内置副本 `data/builtin-mirrors.json`（打包进扩展，`background.js:62 seedMirrors()` 用；装了即固定）；
  2. 远程清单：`lib/core.js:24` 的 `DEFAULT_SETTINGS.remoteList.url` = 那个 raw URL。
- `remoteList.enabled` **默认 false**（`lib/core.js:22-27`）→ 默认只用内置副本。
- 远程拉取 `fetchRemoteList()`（`background.js:258`）：先按 `镜像base/rawURL` 前缀重写尝试各已授权镜像，最后直连；**被墙也能靠镜像取到**。
- `maybeRefreshList()`：距上次成功 **<24h 跳过**；定时器 `ALARM_LIST` 每 **12h** 触发。
- `mergeRemoteList()`（`background.js:323`）：**只增不删**，按 host 去重，最多 60 条，新条目 `score=0`；**不读取 `seedKbps`**。最终排序由扩展**自身探测**决定。
- 因此：**该文件只能「补充候选镜像」，不能设定排名/速度，也不能删除下线镜像。**

---

## 2. 「指向其它可用性检测项目」怎么做

不能重定向，只能**聚合转译**：

1. 取一个返回「镜像 + 状态/延迟」的接口（实测可用：`git.mxg.pub/api/github/list`，字段 `name/url/status/latency`；`hosts.gitcdn.top` 同类）。
2. 过滤 `status=success`、`url` 规范成 `https://host`（同 `normalizeBase`：仅 https、合法 host、去端口路径）。
3. 映射到扩展 schema 写入 `data/builtin-mirrors.json`，提交 `main`。**默认「合并写入」，不是整份覆盖**：源的可用集与本项目自测的内置集几乎不重叠（实测仅 `gh-proxy.com` 重合），覆盖会把实测更快的镜像冲掉，只增不删才会累积成一份更全的候选池（`--replace` 可显式整份替换）。
4. raw 约 5 分钟 CDN 生效。

**候选源对比**

| 源 | 类型 | 含可用性 | 备注 |
|---|---|---|---|
| `git.mxg.pub/api/github/list` | JSON API | ✅ status+latency | 实测 14/7；偶发超时，需容错 |
| `hosts.gitcdn.top` | 页面/数据 | 部分 | 需确认接口形态 |
| CSDN/博客汇总、scoop-plus/aria2 `ghproxy.json` 等 | 静态列表 | ❌ 仅候选 base | 扩展自测可补足 |

> 建议：**多源 + 自测兜底**，不要单点依赖某一个第三方 API。

---

## 3. 「部署服务更新」的三种形态

| 形态 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. GitHub Actions（推荐）** | 定时 workflow：拉源→规范化→(可选)自测→写文件→commit/push main | 零服务器、免费(public)、与仓库一体、`GITHUB_TOKEN` 内置 | cron 可能延迟；提交历史噪音；private 计费 |
| B. 外部 serverless/VPS | CF Worker/云函数/小 VPS，用 PAT 调 GitHub API 或 git push | 探测更自由、可多源重试 | 需保管 PAT、运维成本 |
| C. 本机 cron | Windows 任务计划跑脚本 | 简单 | 需长期开机，不适合公共清单 |

**推荐 A**。核心 workflow 伪代码：

```yaml
on:
  schedule: [{ cron: "0 */6 * * *" }]   # 每 6h
  workflow_dispatch:
permissions: { contents: write }
jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: node tools/refresh-mirrors.mjs      # 拉源→规范化→(可选)自测→写 data/builtin-mirrors.json
      - run: |
          git diff --quiet data/builtin-mirrors.json && exit 0
          git config user.name  "mirror-bot"
          git config user.email "bot@users.noreply.github.com"
          git add data/builtin-mirrors.json
          git commit -m "chore(mirrors): auto refresh [skip ci]"
          git push
```

要点：
- **仅当内容变化才提交**（`git diff --quiet`），避免历史噪音。
- 提交信息带 `[skip ci]`，避免触发其它 workflow。
- 失败时**保留原文件不覆盖**（先写临时文件，校验通过再替换）。
- 必须守住 schema（见 §5），否则 `test/run-tests.mjs:362` 与 `seedMirrors` 会挂。

---

## 4. 关键坑：存量用户触达

- 只更新文件、不改代码：**仅「开启 remoteList 的用户」+「之后的新版本内置」** 生效；已装且没开 remoteList 的用户**不变**。
- 要惠及存量，需**一次性**把 `remoteList.enabled` 默认改 `true`（改代码、发一次版，**不动 URL**）。
  - 代价：每次启动/每 12h 会向 GitHub（或经镜像）发一次请求；隐私上多一个外连。
  - 缓解：加「仅 Wi-Fi/低频/失败静默」；设置页留「关闭远程清单」；首次拉取做节流。
- 若不想发版：只能靠「用户手动开 remoteList」或「你定期发新版更新内置副本」。

---

## 5. Schema 契约（必须遵守）

```json
{
  "updated": "2026-11-08",
  "note": "自动刷新：按可用性/延迟排序",
  "mirrors": [
    { "name": "GH-Proxy", "base": "https://gh-proxy.org", "seedKbps": 178 },
    { "name": "GHFast",   "base": "https://ghfast.top",   "seedKbps": 199, "note": "5 路并发上限" }
  ]
}
```
- `base` 必须 `https://` + 合法 host（`normalizeBase` 只接受这个）；`name`/`seedKbps`/`note` 可选。
- 最多 60 条；按 host 去重；`updated` 便于排障。
- **不要**输出私网/非 https/带路径的 base。

---

## 6. 风险与边界

- **第三方依赖**：接口限流/改格式/下线 → 必须有容错（失败保留旧文件，多源回退）。
- **投毒面**：写入的 base 会进入用户的下载重写规则；校验不严可能把用户导向恶意站 → 只收白名单式来源 + 严格校验 + 人工审查 diff。
- **只增不删**：扩展当前只能加、不能从用户列表里删死镜像；要「踢下线」需扩展 `mergeRemoteList` 支持 `retire` 字段（改代码）。
- **排名不生效**：远程 `seedKbps` 不被读取；服务端排序不会传到客户端（客户端自测为准）。需要服务端排序生效得改 merge 逻辑。
- **raw 被墙**：扩展有镜像前缀回退，但「远程清单」仍依赖至少一个可用镜像或直连成功；失败静默、下次再试。
- **Actions 定时不准**：可能延迟/跳过；public 免费、private 计费。

---

## 7. 建议落地顺序

1. **阶段 1（不发版/不改 URL/只加文件）**：加 `.github/workflows/update-mirrors.yml` + `tools/refresh-mirrors.mjs`（多源聚合 + 可选自测），只服务「已开 remoteList」的用户与未来版本内置。
2. **阶段 2（发一次版）**：`remoteList.enabled` 默认 `true` + 设置开关 + 失败静默，让存量用户自动更新。
3. **阶段 3（可选）**：扩展 `mergeRemoteList` 支持 `seedKbps`/`retire`，实现服务端排序与下线。

---

## 8. 需要你拍板

1. 是否接受**发一次版**把 `remoteList` 默认开启？（决定能否惠及存量用户）
2. 外部源以 **`git.mxg.pub`** 为主，还是**自测为主**（workflow 里实测各镜像，减少第三方依赖）？
3. 是否需要「**下线镜像**」能力？（要改 `mergeRemoteList` 逻辑）
4. 清单刷新频率：每 6h / 每 12h / 每天？

---

## 9. 追加评估（2026-11-08，按你的决定）

**已定**：remoteList 保持用户自选（不改默认）；频率每 6h；候选名单 = git.mxg.pub；双源（git.mxg.pub + 自测）OR 判定「任一可用即算可用」。

### 9.1 「双源 OR」有必要吗？—— 必要性中等偏低，但要重新定位职责

**关键事实**：扩展会**自己探测并按用户本地网络排序**；`mergeRemoteList` 固定 `healthy:true`，**忽略 status / latency / seedKbps**。所以流水线的「可用性判定」**根本不进入客户端选路**，它只决定「这个 base 要不要写进候选池（JSON）」。

- 因此「双源 OR」的真实作用 = **候选发现 + 垃圾过滤**，**不是**「可用性排名」。
- **git.mxg.pub**：CN 向、带 `status/latency`，贴近你的网络 → **适合作主过滤**。
- **自测（GitHub runner）**：探测地在海外，**与你国内网络不一致**——runner 说「可用」不代表你能用、反之亦然；且其延迟/吞吐**没有消费者**（远程 `seedKbps` 被忽略）。→ 自测只适合做「连代理前缀都连不上」的粗筛，别指望它提升选速。
- **结论**：双源 OR **可行、保留无坏处**，但别把它当「可用性判定」。最简更优的做法是：**候选池 = git.mxg.pub 的 success 列表**（扩展本来就会自测）。用双源就用 OR 提高召回，并**明确「自测 = 连通性粗筛，不排序」**。
- 自测唯一的边际价值：写进 bundled 清单的 `seedKbps` 能让**新装机首次排序**好一点（首探即被覆盖）。

> 一句话：**判定可用性交给客户端的真实网络探测；流水线只负责「发现候选 + 剔除明显垃圾」。**

### 9.2 「只增不删」的影响

- 对「**选最快**」几乎无影响：低分/不健康不会被选为 best（`chooseMirrors` 按 score/healthy）。
- 影响集中在别处：
  1. **不可退役**：源里删掉的坏镜像，用户列表里**仍在**（只增不删），只能靠探测降权；**无法通过清单撤回**。
  2. **列表会累积**：`incoming.slice(0,60)` 只限**单次**，总列表可跨多次增长；`probeAll` 每次遍历所有 enabled → 探测时间/流量随列表增长。
  3. **安全**：被投毒/接管的镜像一旦进了用户列表就**撤不掉**。
  4. **好处**：不会因一次误判/抖动就误删可用镜像，对用户更「保守、不破坏」。
- **有界条件**：只要**源名单稳定 + 限量输出**（建议 ≤15 条、只出稳定可用），列表很快收敛（≈10 内置 + 源新增），膨胀可忽略；真正会膨胀的是「源每 6h 轮换新 host」。
- **建议**：pipeline 侧**限量 ≤15 + 只输出稳定项**，把膨胀与垃圾压到最小；要「退役/撤回」能力必须改 `mergeRemoteList`（可选阶段 3：支持 `retire` 或「源里不存在则停用」）。

### 9.3 频率 6h

OK。raw CDN ~5 分钟生效；Actions cron 有延迟。建议「**内容无变化不提交**」，避免每 6h 产生空提交噪音。

### 9.4 结论

- **双源 OR**：保留可以，但定位为「候选发现 + 连通性粗筛」；**主过滤用 git.mxg.pub，自测仅做粗判**。想更简单就只用 git.mxg.pub 的 success 列表。
- **只增不删**：选路无碍，但要接受「不能退役 + 会累积」；用「**限量、稳定输出**」把影响压到最小；确实需要退役再改代码。

---

## 10. 最终实现（2026-11-08 落地）

按你的最终决定实现，**去掉双源 OR，仅用 git.mxg.pub 的 success 列表**：

- **数据源**：仅 `git.mxg.pub/api/github/list` 中 `status=success` 的项（不做自测）。
- **刷新频率**：源带 `Cache-Control: public, max-age=86400`（约日更）→ GitHub Actions **每天一次**（cron `17 3 * * *`），**内容无变化不提交**。
- **删除迟滞**：镜像**连续 24h** 不在 success 列表才移除；用 `listMissing` 记录「首次缺失时间」，避免偶发抖动误删。
- **扩展升级（可增可删）**：
  - 设置页新增开关：**允许删除镜像**（`allowDelete`）；**启用远程清单时默认开启**。
  - 删除策略：**仅 `source=remote`（远程加入的）可删**；`source=builtin`（内置）与 `source=user`（手动添加）**永不因缺失删除**。
  - 核心纯函数 `MFL.syncMirrors()`（`lib/core.js`），后台 `applyRemoteList()` 调用；`test/run-tests.mjs` 的 8.7 组覆盖。
- **新增文件**：`tools/refresh-mirrors.mjs`（支持 `--dry`、`--from <file>` 离线测试）、`.github/workflows/update-mirrors.yml`。
- **隐私不变**：扩展仍只请求用户配置的 `remoteList.url`（默认 raw.githubusercontent）；`git.mxg.pub` **只由 CI 任务访问**，扩展不直连它。
- **测试**：`node test/run-tests.mjs` → **208 通过 / 0 失败**；`node build.mjs` 重建 dist 三端。

> 部署前记得在仓库 Settings → Actions → General 确认 Workflow permissions 为 “Read and write”（或依赖 workflow 里的 `permissions: contents: write`），首次可在 Actions 页手动 `Run workflow` 验证。

### 10.1 时序鲁棒性（2026-11-08 补）

- **删除判定口径**：不再用「now − 首次缺失」这种纯墙钟比较；改为记录每次缺失观测 `{since, last}`——
  - 相邻两次缺失观测间隔 **> 48h**（说明关机/离线），**重新计时、不删**；
  - 否则间隔正常（约 24h），持续缺失满 **24h** 才删。
  - 目的：关机 3 天回来，不会因「墙钟跨过 24h」而在**一次观测**后就误删。
- **刷新闸门**：只认「**上一次成功获取**」的时间（`listFetched.ok === true`）；获取失败不再压制 24h 重试，下一个 12h 定时会重试。
- **启动补拉**：`onStartup` / `onInstalled` 都会触发 `maybeRefreshList`；关机很久后开机会在闸门允许时立即补拉一次（删除仍走上面的迟滞，不会因离线误删）。

### 10.2 删除语义：为何只删「远程加入」的（2026-11-08）

实测 `git.mxg.pub` 总数 **14 / success 7**，**与内置 10 个仅 `gh-proxy.com` 重合**——源只测它自己那 7 个，没测 ≠ 挂了。

进一步核查多个汇总仓库（`XIU2/UserScript`、`docmirror/dev-sidecar`、`hubporg/ghproxy-next`、`clion007/adss`、`SharerMax/ghproxy-check`）：**它们都是静态名单**（SharerMax 的检测在浏览器里跑、无服务端结果文件；CH3NGYZ 测的是 tailscale 不是 gh-proxy）。**没有任何仓库提供「针对内置镜像」的机器可读可用性结果**。

因此按「没有可用性测试就取消内置管理」的原则：
- **取消**「内置列表受清单管理」（`manageBuiltin`）选项；
- 删除策略收敛为：**仅 `source=remote` 可因缺失删除**；`builtin` / `user` **永不因缺失删除**；
- **存在集合用全量 incoming（不截断）**；新增单独限 `maxAdd=60`，两者分离，避免「截断 → 误判缺失」；
- `MAX_MIRRORS` 由 15 → **60**。

> 代价：内置镜像若某天真挂了，不会被清单删掉，只会被扩展自身探测降权、不再被选中（列表里留个“死条目”）。这是「没有权威可用性源」下的安全取舍。

---

## 11. 内置清单来源追溯（2026-11-08 核查）

内置 10 个镜像**不是从单一仓库整包拿的**，而是从多家 GitHub/社区「镜像汇总 / 节点列表」项目里挑选后，再按 2026-11-06 单线程实测速度排序。GitHub 代码搜索 + 逐文件比对：

| 内置镜像 | XIU2/UserScript | docmirror/dev-sidecar | hubporg/ghproxy-next | clion007/adss |
|---|:--:|:--:|:--:|:--:|
| gh.dpik.top | ✗ | ✗ | ✓ | ✓ |
| hub.glowp.xyz | 注释 | ✓ | ✗ | ✗ |
| ghfast.top | ✓ | ✓ | ✓ | ✓ |
| cdn.gh-proxy.org | ✓ | ✓ | ✗ | ✗ |
| gh-proxy.org | ✓ | ✓ | ✗ | ✗ |
| gh.sixyin.com | ✗ | ✗ | ✓ | ✓ |
| gh.monlor.com | ✓ | ✓ | ✓ | ✓ |
| gh.noki.icu | ✗ | ✗ | ✓ | ✓ |
| xget.xi-xu.me | ✓ | ✓ | ✗ | ✗ |
| gh-proxy.com | 说明名 | 说明名 | ✓ | ✓ |

- 「gh-proxy.org / cdn.gh-proxy.org / xget.xi-xu.me / glowp」来自 **XIU2/UserScript、docmirror/dev-sidecar** 这一族；
- 「dpik / sixyin / noki / monlor / gh-proxy.com」来自 **hubporg/ghproxy-next、clion007/adss** 这一族；
- **每个域名都能在至少一个项目里找到，但没有一个仓库同时包含全部 10 个** → 结论是「**跨多源挑选 + 自测排序**」，与文件里「按 2026-11-06 实测单线程速度排序」一致。

> 启示：这也解释了为何 git.mxg.pub 的 7 个 success 与内置 10 个几乎不重叠——它们来自**不同的汇总源、不同时间**。内置 = 自测精选，远程 = git.mxg.pub success，互不越界（见 §10.2）。

---

## 12. 1.4.6 定稿（2026-11-08）

| 环节 | 定稿行为 |
|---|---|
| Action 频率 | 每天 `17 3 * * *`（源 `Cache-Control: max-age=86400`，6h 只会拿到同一份缓存）；支持手动 `workflow_dispatch` |
| 写文件方式 | 精选（无 `auto` 字段）打头、**永不删**；其余**整段按源当前 success 顺序覆盖**——旧地址只要不在这次 success 里就消失，`auto:true` 标出「来自源」；`--replace` 连精选一起替换 |
| 无变化 | 内容相同则**不写文件**；workflow 侧还有 `git diff --quiet` 兜底，不产生空提交 |
| 空结果 | 解析后为空直接抛错退出，不覆盖旧文件 |
| 上限 | `MAX_MIRRORS = 60`（存在集合全量不截断，仅新增受限） |
| 扩展侧删除 | 只剩一个开关「允许删除镜像」；**只删「远程加入且连续 24h 缺失」**；内置与手动添加永不因缺失删除 |
| 取消的选项 | 「内置列表受清单管理」（`manageBuiltin`）——没有任何汇总仓库提供针对内置镜像的机器可读可用性结果，交给清单管理只会误删 |

> 一句话：**Action 产「候选池」，扩展判「增删」；候选池只增不删，删除只针对源亲自认可过的镜像。**

---

## 13. 双人独立审查后的加固（2026-11-08）

主代理与一个独立子代理各自通读代码后，逐条核实并修掉的问题：

| 问题 | 后果 | 加固方式 |
|---|---|---|
| 清单形状不认识（如把 `git.mxg.pub/api/github/list` 的 `{data:[...]}` 填成清单地址）或清单为空 | 被当成「所有镜像都缺失」→ 24h 后静默删光本地远程镜像 | 新增 `pickIncoming()`：只认 `[]` 与 `{mirrors:[]}`，其余返回 `bad-shape` 并换下一个候选源；`syncMirrors` 再加一道 `incomingHosts.size === 0` → 本轮不判定、清空缺失记录 |
| `m.source || 'remote'` | 缺 `source` 的旧记录会被当成可删 | 改为只认 `m.source === 'remote'`，其余一律受保护 |
| `inc.slice(0, maxAdd)` | 前 N 条都已存在时新镜像永远加不进来 | 改成按「真正新增条数」计数 |
| `t - rec.last > offlineGap` | 系统时钟被改到未来再改回来，该 host 永久删不掉 | 加 `t < rec.since` 判定：重新计时 |
| 失败后不记时间 | `bootstrap()` 在每次 SW 唤醒都跑，被墙时每次唤醒都串行重打所有候选源（每个 10s 超时） | 新增 `listAttempt`，失败后 30min 内退避 |
| 启动/点击会并发多次拉取 | 双倍网络 + `listMissing` 互相覆盖 | `runListFetch()` 做 in-flight 去重；`save-settings` 触发的那次改走 `maybeRefreshList(false)`（受 24h 闸门约束） |
| 换清单地址 / 关掉再打开不清缺失计时 | 新清单首轮就被上一份清单的缺失记录连累 | `save-settings` 检测到 url 变化或 `enabled:false` 时清 `listMissing` / `listFetched` / `listAttempt` |
| `remove-mirror` 按 id 删 | `a-b.com` 与 `a.b.com` 会撞 id，一次删两条 | 优先按 `base` 精确匹配，兜底只删第一条；顺手清该 host 的缺失记录 |
| `syncAlarms` 要求 `url` 非空 | 把地址清空（走默认地址）的老用户永远不排期 | 只看 `enabled` |
| `refresh-mirrors.mjs` 的 `status` 没 trim | `"SUCCESS "` 被当成失败丢弃 | `.trim().toLowerCase()` |
| 保留旧条目时未规范化 `base` | 文件里可能留着带路径的 base，与扩展侧不一致 | 写回时统一 `normalizeBase` |
| `--from` 漏写路径 | 静默转成联网请求 | 显式报错 |

> 定稿（2026-11-08 复盘后改）：流水线从「只增不删」改为 **「精选打头 + 其余整段由源覆盖」**——
> 源的顺序与地址都跟随 `git.mxg.pub` 当前的 success：新地址直接顶掉旧地址，旧地址不在 success 里就消失，
> 扩展连续 24h 缺失后才真正删掉，**删除功能因此才有输入**。
> 手工精选（无 `auto` 字段）依旧永不删，避免源没测过它们就被误删。
> 另：内置精选的 10 个镜像源站从未测过，因此永远不参与缺失判定。
