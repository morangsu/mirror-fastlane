# 构建、测试与发版

给改代码的人看。只想装来用的话看 [README](../README.md)。

## 构建

```bash
node build.mjs          # 产出 dist/edge、dist/firefox、dist/debug（debug 仅本机排查用）
```

零外部依赖，Node 内置模块即可，不需要 `npm install`。

- Edge / Chrome：`edge://extensions` 或 `chrome://extensions` → 打开「开发者模式」→「加载解压缩的扩展」→ 选 `dist/edge`
- Firefox：`about:debugging` → 「此 Firefox」→ 「临时载入附加组件」→ 选 `dist/firefox/manifest.json`

> Chrome 156 起不再支持用 `--load-extension` 命令行加载扩展，需要命令行加载时用 Edge 或 Chrome for Testing。
>
> 根目录的 `manifest.json` 是构建模板（同时声明 `service_worker` 与 `scripts`，构建时按目标裁剪），**不要直接把仓库根目录当成「加载解压缩的扩展」**。

版本号是构建派生的：改 `manifest.json` 与 `package.json` 的 `version`，`build.mjs` 会写进 dist 与设置页展示。

## 测试

```bash
npm test                       # 全套（build + 下面 8 组）
node test/run-tests.mjs        # 纯逻辑 + 清单完整性 + 合规扫描 + 发布防呆（278 项）
node test/debug-log-test.mjs   # 调试日志并发写入与脱敏（4 项）
node test/content-state-test.mjs # 内容脚本状态刷新（7 项）
node test/refresh-mirrors-test.mjs # 清单刷新脚本：精选保留 / 整段覆盖 / 空源拒绝（30 项）
node test/browser-smoke.mjs    # 真浏览器加载扩展，校验规则/设置页/校验页（42 项）
node test/redirect-check.mjs   # 端到端：github 链接确实被 302 到镜像（10 项）
node test/taskfile-e2e.mjs     # 端到端：扩展写出的校验任务文件内容正确（18 项）
node test/run-ps-tests.mjs     # 脚本逻辑（79 项断言，自动找 pwsh / powershell）
node test/verify-release-test.mjs # 发版体检自身的回归（8 项，纯临时目录）
npx --yes web-ext lint --source-dir dist/firefox   # Firefox 上架前静态检查
```

单元测试 278 项、脚本测试 79 项，其余 119 项（debug 日志 4 + 内容脚本 7 + 清单刷新 30 + 冒烟 42 + 改写 10 + 任务文件 18 + 发版体检 8），合计 **476 项**。

`test/run-ps-tests.mjs` 会自动找 `pwsh` 或 `powershell`，在临时目录里跑完全部用例：

```
任务+子文件夹 / 期望值不一致 / 无期望值 / 重命名副本 (1) / 多副本取最新 /
旧文件不误判 / 覆盖同名 / 过期任务清理 / aria2 显式路径 / 失败回报 /
跨目录配对 / 多任务并发 / 不误处理内部文件 / 回源复核开关 / 字节数锚点 /
来源合成 / 回源边界 / 脚本完整性自检 / 非 GitHub 下载不打扰
```

`test/probe-*.mjs` 是浏览器能力的一次性探测脚本（下载协议兼容性、IDM 是否劫持、扩展能否写文件），会往真实下载目录写测试文件，不属于常规测试，别在无关环境运行。

冒烟测试需要本机有 Edge 或 Chrome：

- 默认按顺序找 `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`、`D:/scoop/apps/googlechrome/current/chrome.exe`
- 也可以 `MFL_BIN=<浏览器路径> node test/browser-smoke.mjs`
- Chrome 137+ 忽略命令行 `--load-extension`，脚本改用 CDP `Extensions.loadUnpacked` 加载

## 维护脚本

- `npm run sync:store-readme`：打包后从 `build-info.json` 自动把三个包的体积与 SHA-256 写进 `store/README.md`，不用手抄。
- `npm run check:release`（`tools/verify-release.mjs`）：发版前一键体检 —— 版本一致性、三个 zip 的完整性与 SHA-256、`store/README.md` 哈希、源码包不含 `dist/docs/store/archive`、正式包调试日志为 stub。
- `npm run check:mirrors`（`tools/validate-mirrors.mjs`）：清单 schema 门禁；`update-mirrors.yml` 在 bot 提交前也会跑，坏清单进不了 main。
- `npm run check:idm`：核对 IDM 的「病毒检查」钩子配置（解释器、脚本路径、哈希基线、`[File]` 占位符、值尾部多余换行）。

### CI

`.github/workflows/test.yml`：push / PR 跑纯 Node 测试（构建、逻辑单测、schema、发版体检回归）；另外用 Chrome for Testing + Xvfb 跑一遍 42 项真浏览器冒烟，**该步骤是顾问式的**（`continue-on-error`）—— Chrome 157 在 runner 容器里不会把本扩展的 MV3 service worker 暴露成 CDP 目标，扩展装得上、设置页开得了，但冒烟依赖的 SW 会话断言跑不了，所以只保证能跑、日志可查，不阻塞合并。本机的冒烟仍是阻塞式。

`.github/workflows/update-mirrors.yml`：每天按 `git.mxg.pub` 的 success 列表刷新 `data/builtin-mirrors.json`，校验通过才提交。清单的合并规则见 [how-it-works.md](./how-it-works.md#清单会自动更新)。

## 打包与上架

两个商店都要求「无远程代码 + 可审查的源码」，交付方式一致：

| 商店 | 提交什么 | 说明 |
|---|---|---|
| Edge Add-ons | `dist/edge` 打成的 zip | 隐私政策 URL 用本仓库 `privacy.md`；权限说明见 `store/permissions.md` |
| Firefox AMO | `dist/firefox` 打成的 zip | manifest 已声明 `data_collection_permissions.required: ["none"]`；源码即本仓库，必要时可在 AMO 里指定「源码在仓库」 |

打包（不依赖第三方工具）：

```powershell
npm run store       # build + logo + 截图 + 打包，一步生成 store/packages/ 下三个 zip
npm run pack        # 只重新打包（不重拍截图）

# 也可手工打包（不依赖脚本自带的 zip 实现）：
Compress-Archive -Path dist\edge\*    -DestinationPath mirror-fastlane-edge-1.4.12.zip -Force
Compress-Archive -Path dist\firefox\* -DestinationPath mirror-fastlane-firefox-1.4.12.zip -Force
```

发布顺序是 **提交 → 重新 pack（只刷新 `build-info.json` 里的 commit）→ 打 tag**；顺序反了 tag 会指向上一个提交。

`hooks/` 不在扩展包里 —— 它是可选增强，单独作为 release 资产发布，设置页里链接到 release 页，用户自己下载并审查。

## 本地化

`name` / `description` / `action.default_title` 走 `_locales`（`en` 与 `zh_CN`），`default_locale: en`。这是商店识别「可选语言」的依据 —— 没有 `_locales` 目录时，Edge 只会认出 English (United States) 一种，无法添加简体中文的商店文案。

设置页的状态、按钮、表头与关键提示也走 `_locales`；正文说明保持中文。

## 扩展 ID

`mirror-fastlane@morangsu.github.io`（与 `zenith-newtab@morangsu.github.io` 同一命名约定，即 `<仓库名>@morangsu.github.io`）。AMO 首次提交后 id 不可更改，提交前请不要再动它。
