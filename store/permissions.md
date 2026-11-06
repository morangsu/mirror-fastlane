# 权限与隐私申报（Partner Center → Privacy）

> Edge 的 Privacy 页会逐项问「为什么需要这个权限」。下面是可直接粘贴的答案，中英各一份，英文版给国际审核员更稳妥。

## 1. 单一用途（Single purpose）

**中文**
```
把 GitHub 的下载链接改写到用户选定的镜像，并在页面上标明这次请求由哪个镜像服务。
```

**English**
```
Rewrite GitHub download links to a mirror the user has chosen, and label on the page which mirror is serving the request.
```

## 2. 是否收集或传输用户数据

**回答：否（No）**

- 无账号体系、无遥测、无分析、无崩溃上报、无远程日志。
- 不读取浏览历史、不读取页面内容（仅在 github.com 页面上插入一个可见徽章，不改动原有 DOM 结构）。
- 唯一可能的外发请求见下表，全部由用户操作触发。

| 什么时候会发请求 | 发往哪里 | 内容 |
|---|---|---|
| 打开 GitHub 页面且开启测速 | 用户自己添加/内置的镜像域名 | 一个固定的测试文件地址（ripgrep 的一个 release 资产），仅用于测速；不发任何本地数据 |
| 开启哈希校验后点击下载 | `https://api.github.com` | 仓库与 release 路径；只读 GET，取官方 SHA-256 |
| 用户开启远程清单并手动获取 | 用户自己填写的 URL | 只读 GET |
| 可选：本地脚本回源复核 | `https://api.github.com` | 资产 id；只读 GET |

## 3. 远程代码（Remote code）

**回答：否**

所有可执行代码都在扩展包内。远程清单（可选）只按 JSON 解析，字段白名单校验，不执行任何内容，不使用 `eval` / `new Function` / 远程 `<script>`。
（测试里有对应断言：扫描全部源文件，发现 `eval`、`new Function`、远程脚本或硬编码令牌即失败。）

## 4. 权限逐项理由

### `storage`
```
保存本机设置、镜像列表和最近一次测速结果。全部只存在浏览器本地，不上传。
```
```
Stores settings, the mirror list and the latest probe results locally. Nothing leaves the device.
```

### `alarms`
```
只在用户选择「定时测速」时用于调度；默认的「仅按需」模式不使用定时器。
```
```
Used only when the user picks scheduled probing; the default on-demand mode does not use timers.
```

### `downloads`
```
仅用于写作校验任务：把几十字节的 JSON 写进下载目录下的 _mfl-tasks 子目录，交给本地脚本读取。
不读取、不列举、不删除用户的下载内容；该功能默认关闭。
```
```
Used only to write a small verification task file (a few dozen bytes of JSON) into the _mfl-tasks
subfolder of the download directory, for a companion local script to read. It never reads, lists or
deletes the user's downloads. The feature is off by default.
```

### `declarativeNetRequest`
```
把匹配 GitHub release / 源码包格式的请求重定向到镜像。规则由扩展在本地生成，不读取请求内容、
不注入脚本、不修改响应体。
```
```
Redirects requests that match the GitHub release / source-archive URL patterns to a mirror. Rules are
generated locally; the extension does not read request contents, inject scripts, or modify responses.
```

### 主机权限 `https://github.com/*`
```
1) 在 release 页面给下载链接加一个「镜像」徽章（内容脚本，仅此页面）；
2) 让下载链接的改写覆盖 github.com 上的请求。
```
```
1) Add a "mirror" badge next to download links on release pages (content script, this domain only);
2) Let the redirect rules cover requests originating on github.com.
```

### 主机权限 `https://codeload.github.com/*`
```
同样的改写，用于源码包（/archive/ 与 codeload 直链）。该功能默认关闭。
```
```
The same rewriting for source archives (codeload URLs). Off by default.
```

### 可选主机权限 `https://*/*`
```
仅用于测速与改写用户自己添加的镜像域名。每一项都需要用户在设置页逐个点击授权；
拒绝授权不影响核心功能——改写本身不需要访问镜像站点的权限，只是无法自动测速排序。
```
```
Only for speed-testing and rewriting mirror domains that the user adds. Each origin is requested
individually from the settings page. Declining does not break the core feature: rewriting itself does
not need host access to the mirror, the extension just cannot rank mirrors automatically.
```

## 5. Cookie / 跟踪 / 广告

全部为否。扩展不设置 cookie，不读取 cookie，不含任何广告或联盟链接。

## 6. 认证信息

可选填写 GitHub 个人访问令牌（只读、仅公共仓库），用于把 API 限额从 60 次/小时提到 5000 次/小时。
令牌明文保存在浏览器的 `storage.local`，只发送给 `api.github.com`，不经过任何第三方。
不填也能正常工作（只是限额低）。

## 7. 内容脚本范围

只在 `https://github.com/*` 上运行，`document_idle` 注入，作用限于：插入徽章元素、监听对 release 链接的点击并弹一条提示。
不修改页面原有内容，不读取表单、不拦截输入。

## 8. 已知限制（主动申明，减少审核来回）

- 不改写浏览器之外的请求：如果你把链接粘给 IDM 之类的下载器，扩展管不到。
- 镜像由第三方运营，扩展只负责选择与标注；文件是否可信由哈希校验（可选）负责。
- 单个请求只会走一个镜像（DNR 没有请求级回退），镜像失效要等下一轮测速才会被换掉。
