# 构建说明（给 AMO 审核 / Build instructions for AMO reviewers）

## 结论

本扩展**使用了构建脚本**，因此提交时选择「是，使用了构建工具」并附上源码包。
构建脚本只用 Node.js 内置模块，全部可读、无第三方依赖、无网络请求。

`node build.mjs` 做四件事：

1. 把源码目录（`lib/` `content/` `options/` `popup/` `verify/` `data/` `icons/` `_locales/`）原样复制到 `dist/<target>/`；
2. 按目标**裁剪 `manifest.json` 里不兼容的键**（Firefox 删 `minimum_chrome_version`、`background` 只留 `scripts`；Chromium 删 `browser_specific_settings`、`background` 只留 `service_worker`）；
3. 用几何算法**生成 PNG 图标**（`icons/*.png`）；
4. 对正式目标（`dist/edge`、`dist/firefox`）做两处裁剪：把 `lib/debug-log.js` 换成同接口的 **no-op stub**（保留文件名，避免 HTML / manifest / `importScripts` 出现 404），并移除 `options/options.html` 中 `MFL_DEBUG_PANEL_START/END` 之间的调试面板 DOM。`dist/debug` 不裁剪，保留完整调试实现，仅供本机排查，**不进商店、不进 release**。

`node tools/pack.mjs` 把构建产物打成三个 zip（Edge 包、Firefox 包、源码包），时间戳固定以便按 SHA-256 复核；源码包不含 `dist/`、`store/` 商店提交物、`docs/`（内部设计/评审记录）、一次性探测脚本、本地凭据或任务文件。

**不做**：不压缩 / 不混淆 JS、不合并模块、不使用模板引擎、不下载外部资源、不执行远程代码。

## 复现

```
Node.js >= 18，无第三方依赖
npm run build       # 生成 dist/edge、dist/firefox、dist/debug
npm run pack        # 生成 store/packages/ 下三个 zip
npm run store       # build + logo + 截图 + pack（一步到位）
npm test            # 全套回归测试
```

输出：

- `dist/firefox/` —— 与 Firefox 上架包逐字节对应（除 zip 时间戳）
- `dist/edge/` —— Chromium 上架包，同一份源码裁剪而成
- `dist/debug/` —— 仅本机排查，带 `debug: true`，不发布

验证方式：包内每个 `.js` / `.html` / `.css` 都能在源码里找到同字节文件，**例外只有三处**：`manifest.json`（按目标裁剪）、`icons/*.png`（脚本生成）、以及正式包的 `lib/debug-log.js`（no-op stub）与 `options/options.html`（剥离调试面板）。

## 版本对应

- 提交版本：`1.4.11`
- 源码仓库：https://github.com/morangsu/mirror-fastlane
- 对应 tag：`v1.4.11`；对应提交见仓库 `git log` 与该 tag 指向的 commit
- 本地构建清单 `store/packages/build-info.json` 记录打包时的 commit 与各包 SHA-256，仅用于本机核对，不随源码包分发
- 上架包 SHA-256：见 `store/README.md`。zip comment 写入版本号而非 commit hash，避免「提交 → 打包 → 哈希变化 → 改文档 → 再提交」的循环依赖
