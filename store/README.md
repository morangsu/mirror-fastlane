# 商店提交清单

Partner Center 左侧五个分页分别要填什么，对应的文件与文案都在本目录。

## 文件位置

全部在 `E:\WorkBuddy AI\richang\local\mirror-fastlane\store\`：

| 用途 | 文件 |
|---|---|
| Edge 上架包 | `packages\mirror-fastlane-edge-1.4.2.zip`（44,789 B，SHA-256 `5539aef7…`） |
| Firefox 上架包 | `packages\mirror-fastlane-firefox-1.4.2.zip`（44,913 B，SHA-256 `66f5f488…`） |
| 商店 Logo 300×300 | `logo-300.png` |
| 备用 Logo 512×512 | `logo-512.png` |
| 截图（1280×800，4 张） | `screenshots\01-overview.png`、`02-probe-window.png`、`03-hash.png`、`04-verify.png` |
| 中文文案 | `listing-zh-CN.md` |
| 英文文案 | `listing-en-US.md` |
| 权限与隐私申报话术 | `permissions.md` |

包里已有全部代码，不需要再单独上传脚本；`hooks/` 是可选增强，走 GitHub release 分发。

## Packages 页

- 上传 `packages\mirror-fastlane-edge-1.4.2.zip`
- 上传后 Partner Center 会解析 manifest，确认显示为 `镜像快车道 / 1.4.2`
- 若提示缺图，检查 zip 根目录是否有 `manifest.json`（本包是展开的，没有外层文件夹）

## Availability 页

| 字段 | 填什么 |
|---|---|
| Markets | 全选（或至少保留 China、United States、Japan、Germany、Singapore） |
| Visibility | Public |
| Pricing | Free（Edge 插件只能免费） |
| Release schedule | As soon as certification completes（想手动放量再选 Manual） |

## Properties 页

| 字段 | 填什么 |
|---|---|
| Category | `Developer tools`（第二分类可选 `Productivity`） |
| Privacy policy URL | `https://github.com/morangsu/mirror-fastlane/blob/main/privacy.md` |
| Website | `https://github.com/morangsu/mirror-fastlane` |
| Support contact | 你的邮箱 + `https://github.com/morangsu/mirror-fastlane/issues` |
| Mature content | No |

## Privacy 页

按 `permissions.md` 抄：单一用途声明、数据收集选 **No**、远程代码选 **No**、每个权限的理由（`storage` / `alarms` / `downloads` / `declarativeNetRequest` / 两个 host 权限 / 可选的 `https://*/*`）。

那一页有「数据使用」勾选项时，全部不勾（不收集、不出售、不用于广告）。

## Store listings 页

先选语言，再逐项粘贴：

- **Chinese (Simplified)** → `listing-zh-CN.md`
- **English (United States)** → `listing-en-US.md`

上传资源：

- Logo：`logo-300.png`
- 截图：`screenshots\` 里 4 张，按 01→04 顺序，配文见文案文件末尾

## 重新生成这些资产

```powershell
npm run store          # build + logo + 截图，一步到位
npm run store:assets   # 只出 logo
npm run store:shots    # 只重拍截图（会启动一次无头 Edge）
```

截图是真实运行状态（浅色主题、1280×800），不是设计图；换版本后重跑即可。

## Firefox（AMO）对应关系

| AMO 字段 | 填什么 |
|---|---|
| Name | 镜像快车道 |
| Summary（≤250） | 用 `listing-zh-CN.md` 的「简短描述」 |
| Description | 用「详细描述」 |
| Categories | Developer Tools |
| Tags | github, mirror, download, checksum |
| Privacy policy | 同上的 privacy.md 链接 |
| License | MIT |
| 上传包 | `packages\mirror-fastlane-firefox-1.4.2.zip` |

AMO 会问「是否使用构建工具」——回答是，构建命令 `node build.mjs`，源码在同仓库（无需额外上传源码包，但可在备注里写明）。
Firefox 的扩展 ID 已定稿为 `mirror-fastlane@morangsu.github.io`，提交后不可更改。

## 提交前自检

- [ ] 本地加载 `dist\edge` 能正常开关、规则数 ≥1
- [ ] 设置页「规则状态」显示「生效中」
- [ ] 文案里没有具体价格/承诺（避免"加速 10 倍"这类不可验证表述）
- [ ] 隐私政策链接在无痕窗口能打开
- [ ] zip 里没有 `store/`、`test/`、`hooks/` 等无关目录
