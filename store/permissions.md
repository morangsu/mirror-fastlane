# Partner Center · Privacy 页逐框填写

> 对应截图里的 7 个输入框，全部英文（审核员看英文更稳），每框都在 1000 字符以内。
> 直接整段复制，不要带反引号或列表符号之外的格式。

### Single purpose description

```
Mirror Fastlane has exactly one purpose: when the user opens a GitHub download link (release asset or source archive), the extension rewrites that request to a mirror host — one the user has added, or one the extension has measured as reachable — and shows on the page which mirror is serving the file.

It does nothing beyond that: it does not proxy browsing or change the user's IP, it does not modify page content except inserting a small "mirror" badge next to download links, it collects no data, and it runs on no site other than GitHub.
```

（543 字符）

### storage justification

```
Stores the extension's own configuration and measurement state on the user's device: on/off switch, probe mode and interval, optional active-hours window, optional hash-verification flags and a user-supplied read-only GitHub token, the mirror list (built-in plus any mirrors the user added), and the last measured speed/latency per mirror.

All of it lives in browser-local storage; nothing is uploaded, synced or shared. Without this permission the extension would forget the user's configuration and mirror ranking on every restart, and the "one click to enable" flow could not work.
```

（585 字符）

### alarms justification

```
Used only for timing local housekeeping, never for background network work of its own:

- when the user explicitly selects the "scheduled" probe mode, to trigger a speed test every N minutes (minimum 15);
- a 5-minute tick that re-evaluates the active-hours boundary, so rewriting starts and stops on time instead of waiting for the next page load.

The default "on-demand" mode uses no timers at all.
```

（401 字符）

### downloads justification

```
Used for one narrow thing: writing a verification task file.

When the user enables the optional hash-verification feature and clicks a GitHub download, the extension saves a few-dozen-byte JSON file (filename, expected SHA-256, repository, tag, asset id) into a dedicated "_mfl-tasks" subfolder of the browser's download directory. A companion local script, which the user installs separately, reads that file after the download finishes and compares the hash.

The extension never reads, lists, moves or deletes the user's downloads. The feature is off by default, and the permission is not used for anything else.
```

（616 字符）

### declarativeNetRequest justification

```
Used to perform the extension's single purpose: redirecting requests whose URL matches GitHub release-asset or codeload archive patterns to the chosen mirror, e.g.
https://github.com/o/r/releases/download/v1/a.zip  →  https://<mirror>/https://github.com/o/r/releases/download/v1/a.zip

The rules are generated locally at runtime from the user's mirror list and the measured ranking (1-2 rules total). The extension does not read request bodies, does not inject scripts and does not modify responses; there is no static ruleset that could affect other sites. Without this permission the extension cannot function.
```

（612 字符）

### Host permission justification

```
Required hosts — the only two the extension touches automatically:

• https://github.com/* — (a) the content script that inserts a "mirror" badge next to release download links and shows a click toast; (b) so the redirect rules apply to requests initiated on github.com.
• https://codeload.github.com/* — the same rewriting for source archives (feature off by default).

Optional host permission https://*/* is NOT granted at install. It is requested per-origin from the options page, only for mirror domains the user adds, and only to run speed tests against them. Declining it does not break the core feature: rewriting works without host access to the mirror, the extension simply cannot rank mirrors automatically.

• https://api.github.com/* — also covered by that optional permission, but requested separately and dynamically only when the user enables hash verification. The extension then makes a read-only GET for the release asset's official SHA-256 digest; it never writes to GitHub and never uses this origin for mirror probing. It is not granted at install, and declining it disables hash verification while leaving rewriting untouched. A user-supplied read-only token, if any, is sent only in the Authorization header of that request.
```

（718 字符）

### Justification（Remote code = No 时）

```
No remote code. Every executable line ships inside the package: no eval, no new Function, no remote <script>, no runtime-fetched WASM.

The only remote data is an optional mirror list, which is parsed as JSON with a field whitelist (https URLs only) and never executed. A repository test scans all sources and fails if eval / new Function / remote script tags / hardcoded tokens appear.
```

（386 字符）

---

## 填写要点（避免被打回）

1. **单一用途**只写"一件事"，不要顺带说测速、校验、远程清单——那些是支撑手段，写在权限理由里。
2. **每个权限都必须回答"为什么非它不可"**，而不是"它能干什么"。所以每条都写了"没有它会怎样"。
3. **Host permission 一栏要覆盖三类**：两个必需域 + 可选的 `https://*/*`。审核最容易在这里追问，必须说清"可选、逐域授权、拒绝不影响核心功能"。
4. **远程代码选 No**，并在 Justification 里给出可核查的证据（"仓库里有测试会扫描 eval / 远程脚本"）。
5. 不要出现"加速 10 倍""更快"这类无法验证的表述。

## 参考：真实数据流（审核追问时备用）

| 触发条件 | 目标 | 内容 | 是否含用户数据 |
|---|---|---|---|
| 打开 GitHub 页面 + 用户开启测速 | 用户添加/内置的镜像域 | 固定测试资产地址的 Range 请求 | 否 |
| 用户开启哈希校验后点下载 | `https://api.github.com` | 仓库/release 路径，只读 GET | 否（可选 Token 仅发往此处） |
| 用户开启远程清单并手动获取 | 用户自填 URL | 只读 GET | 否 |
| 本地脚本回源复核（可选） | `https://api.github.com` | 资产 id，只读 GET | 否 |

## 参考：中文版（自查用，不必贴进表单）

- 单一用途：把 GitHub 下载链接改写到用户选定的镜像，并在页面上标明这次由谁服务。
- storage：存本机设置、镜像列表与测速结果，不上传。
- alarms：只用于定时测速与生效时段边界校正，默认模式不用定时器。
- downloads：仅写一个几十字节的校验任务文件到下载目录的 _mfl-tasks 子目录，不读不删用户下载，默认关闭。
- declarativeNetRequest：把匹配 GitHub release / 源码包格式的请求重定向到镜像，本地生成 1~2 条规则，不读请求体、不改响应。
- 主机权限：github.com 用于插入徽章并让改写覆盖该域请求；codeload 用于源码包（默认关）；可选 `https://*/*` 逐域授权、仅用于测速，拒绝不影响改写。
- 远程代码：无，全部代码在包内，远程清单只当 JSON 解析。

## 已知限制（主动申明，减少来回）

- 不改写浏览器之外的请求（例如粘贴给 IDM 的原链）。
- 镜像由第三方运营，扩展只负责选择与标注。
- 单个请求只走一个镜像（DNR 无请求级回退），失效要等下一轮测速。
