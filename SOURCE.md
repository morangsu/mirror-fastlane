# 构建说明（给 AMO 审核 / Build instructions for AMO reviewers）

## 结论

本扩展**使用了构建脚本**，因此本次提交选择「是，使用了构建工具」并附上源码。
构建脚本只做三件事，全部可读、无依赖、无网络：

1. 把源码目录（`lib/` `content/` `options/` `popup/` `verify/` `data/` `icons/` `_locales/`）原样复制到 `dist/<target>/`；
2. 按目标**裁剪 `manifest.json` 里不兼容的键**（Firefox 删 `minimum_chrome_version`、`background` 只留 `scripts`；
   Chromium 删 `browser_specific_settings`、`background` 只留 `service_worker`）；
3. 用脚本按几何算法**生成 PNG 图标**（`icons/*.png`、`store/logo-*.png`）。

**不做**：不压缩、不混淆、不打包合并 JS、不使用模板引擎、不下载任何外部资源。

## 复现

```
Node.js >= 18，无第三方依赖
node build.mjs
```

输出：

- `dist/firefox/` —— 与本次提交的包逐字节对应（除 zip 时间戳）
- `dist/edge/` —— Chromium 版本，同一份源码裁剪而成

验证方式：包内每个 `.js` / `.html` / `.css` 都能在源码里找到**同字节**的文件，
差别只有 `manifest.json`（按目标裁剪）与 `icons/*.png`（脚本生成）。

## 版本对应

- 提交版本：`1.4.2`
- 源码仓库：https://github.com/morangsu/mirror-fastlane
- 对应提交：见 `git log`，tag `v1.4.2`
