# 深色主题与 Desktop 部署验证

日期：2026-10-12

## 修改范围

- `src/styles.css` 使用 DSH 的背景、文字、边框、品牌色和状态色 tokens；补齐缺省浅/深主题、原生按钮、编辑框、链接、焦点态及待确认高亮的对比度。
- DSH Desktop 的 `body[data-ds-dark-theme]` / `.dark` 主题标记直接作用于成果面板，不增加运行时依赖或主题监听器。独立浏览器成果页另按系统深色偏好回退。
- UI 测试夹具不再依赖 `@napi-rs/canvas` 生成图片，改用包内已有 PNG 资源；只改测试输入。

## 验证

- `node dsh-plugins/dsh-ccpg-scheme/test/client.test.mjs`：43/43 通过。
- `npm test`：全仓测试通过，日志末尾为“全部单测通过”。
- `sh dsh-plugins/build-web.sh`：成功；Vite 对大 chunk、内联 data URL 有既存提示，无构建错误。
- 隔离成果页 computed styles：浅色为白底/深文字，深色为 `#181818` / `#ededed` 系列；主题标记移除和恢复均即时生效。桌面和 380px 窄宽下无页面横向溢出；编辑框、待确认面板与原图正常，图片 `filter:none`。
- 内部运行检查：打包解压版和 Desktop 当前链接版均输出 `ready:true`、15 章节、`nativeDependencies:false`、`darwin/arm64`。
- 生成 `0.12.0-internal.portable.r18`：593 个插件文件；ZIP 约 39 MiB，插件 tgz 约 37 MiB。与 r17 的 delivery package 文件清单完全相同，sidebar `0.25.0` tgz SHA-256 不变；r18 带最新成果页客户端包。包内检查排除了 OS 原生运行依赖。
- macOS DSH Desktop `2.0.17-beta.1` 完整退出后重启。真实面板在深色主题下的章节导航、正文、右栏和待确认标记均正常；导出的桌面截图：`/Users/linbiqiu/new-api-test/plugin-backups/ccpg-scheme-20261012-165736/dark-mode-desktop.png`。
- 重启前后 DSH desktop profile 的 `package.json`、`pnpm-lock.yaml` SHA-256 未变；真实方案 `.ccpg-scheme/state.json` revision 为 152，SHA-256 未变。未操作正文、确认状态或云文件。
- 用户反馈深色待确认标记仍不够醒目后，深色背景混色比例从 24% 提至 42%，并将底部警示线加粗到 2px；浅色背景仍为 24%。客户端 43/43、全仓测试和双端构建通过。
- 追加打包为 `0.12.0-internal.portable.r19`（593 个运行文件，ZIP 约 39 MiB），聚合目录运行自检 `ready:true`、15 章、`nativeDependencies:false`。macOS Desktop 完整退出并重开；新 Host 日志确认 `dsh-harness-one` 的 8 个子插件已装配。未登录直连本地成果 API 返回预期 401。
- r19 更新前将正在链接的 r18 聚合目录和 r18 ZIP 另存至 `/Users/linbiqiu/new-api-test/plugin-backups/ccpg-scheme-highlight-20261012-173451`。profile `package.json` 与 `pnpm-lock.yaml` SHA-256 在重启前后不变。

## 备份与恢复

部署前备份目录：`/Users/linbiqiu/new-api-test/plugin-backups/ccpg-scheme-20261012-165736`

包含当时的 Desktop 聚合插件目录压缩包、原安装聚合目录、profile manifest/lock、r17 ZIP 和完整源码 Git bundle。目录权限为当前用户独占。恢复插件时退出 DSH Desktop，再将 `desktop-installed-directory` 放回 `dsh-plugins/dsh-harness-one`；不要恢复 profile manifest/lock 来覆盖之后可能产生的用户配置。

r19 部署前的 r18 聚合目录与 portable ZIP 备份：`/Users/linbiqiu/new-api-test/plugin-backups/ccpg-scheme-highlight-20261012-173451`。聚合目录 tar SHA-256：`4e5a28af5d41170582d04c63b0b5ce43cfbb5bafe0034936a5194716af432c76`。

## 包差异与兼容边界

- 原 Desktop 聚合包版本 `0.11.4` 已内置方案插件，但仍含 `@napi-rs/canvas`、`@deepseek-ai/libreoffice-kit`、`pdfjs-dist` 等运行依赖。
- 新包是 `0.12.0-internal.portable.r18`，包含 Workflow One 七个原有插件和 CCPG 方案插件，侧栏仍为 `0.25.0`。方案文档解析/导出依赖改为 JS/WASM，包的运行依赖清单不包含原生 canvas/LibreOffice/OCR。
- 当前本机已更新到 `0.12.0-internal.portable.r19`；相较 r18 仅加强深色待确认标记，无运行依赖或 profile 锁文件变化。
- 安装器声明支持 macOS、Windows、Linux 的 x64/arm64，Node `>=22.19.0`、DSH `>=0.2.0-rc.2 <0.3.0`；安装依赖需要网络，并使用每位用户自己的 DSH 环境及模型/飞书登录。
- 本轮只在 macOS arm64 DSH Desktop 做了真实安装运行验证。Windows/Linux 和不同 DSH 版本未实机验证，因此不能声称目标用户“无条件都能用”；需满足版本前提并在目标环境做安装验证。内部包并非公共 npm 发布。

## 未做

没有在另一台机器或 Windows/Linux 安装包；没有更改 DSH 全局浅/深色设置、其他插件、用户方案文件或远端飞书文档。PDF 解析器其他故障不属于这次主题变更，也没有据此声称已修复。
