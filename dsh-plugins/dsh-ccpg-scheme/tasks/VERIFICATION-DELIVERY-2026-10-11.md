# 最终交付、PDF Desktop 运行与安装验证

日期：2026-10-11，Asia/Shanghai。分支：`codex/ccpg-scheme-tdd`。

**后续更正**：下文“Desktop PDF 实测”实际在 Desktop 可执行文件的 `ELECTRON_RUN_AS_NODE=1` 模式运行，不是在 Desktop utility Host 内执行；此前只覆盖 builtin module require 受限，漏测 `process.type='utility'` 下 PDF.js 的环境分支。用户后续稳定复现 worker 路径为空，证实旧结果不能代表真实 Host 已通过。保留历史结果，最新修复、验证边界与安装记录见 [章节发布与 PDF worker 验证](VERIFICATION-CHAPTER-PUBLISH-2026-10-11.md)。

## 本轮范围与结果

- 用户截图的第 11 章 `DOMMatrix is not defined`：共享 PDF.js 加载入口在导入前补齐真实 canvas 类型，文字提取与页数读取复用同一入口。`@napi-rs/canvas@0.1.100` 显式进入独立插件和内部聚合包依赖。
- 章节与附件页移除逐页“汇总全文”和底部重复交付卡；自然顺序最后一章有有效成果后，在导航末尾提供“全文交付”。正文和附件继续使用同一自然目录，最终交付单独展示正文与附件。
- 全文交付只有一组下载 ZIP、保存到方案目录、转为飞书云文档操作。未保存草稿阻断交付；旧版本交付失效后要求更新；未完成或未确认章节阻断云发布。更新交付只刷新交付快照，不控制模型运行。
- 页面云发布与 `scheme_publish` 复用同一后端：当前用户 CLI、原生单次批准、固定快照、批准后完整性复核、取消、回执和回读。原生人工发布命令要求当前 revision，人工保存也拒绝过期 revision；旧调用未提供 export revision 时保持兼容。
- 正文插图及图片附件展示原图。编辑保存、章节/全文 ZIP 保留原图字节和相对引用；不存在的原图只提示缺口，不生成假图片。

## 最新验证

| 验证 | 实际结果 |
| --- | --- |
| 全仓 `npm test` | 退出码 0，末尾“全部单测通过”；日志 `/tmp/ccpg-scheme-delivery-final-tests-20261011.log` |
| 收尾聚焦回归 | materials 28/28、client 35/35、Host 15/15，零失败/跳过 |
| 构建和包契约 | prescribed `pack.sh` 含双构建成功；`build-scheme.sh --check`、`verify-plugin-packages.mjs`、`git diff --check` 通过；聚合 593 文件、4 个 client factories |
| Desktop PDF 实测 | 安装路径解析器在 Electron 44.0.0 / Node 24.18.1 中运行，模拟 builtin module require 受限；两份实际第 11 章知识 PDF 生成 2302、1912 bytes Markdown，无 DOMMatrix 异常 |
| 隔离真实浏览器 | 640×360 PNG 在正文和图片附件中加载；380px 面板中显示宽度 348px，无页面横向溢出；编辑、保存、重载保留原图 |
| ZIP 与发布边界 | 全文 ZIP 包含正文、图文附件、图片原件、正文图片与交付清单；模拟云发布成功链接、拒绝/无写入、重复快照复用、变更失效和未确认阻断通过 |
| 源码/安装/归档 | 451 个 `lib/rules/skills/package.json` 文件，源码与聚合、Desktop 链接、独立归档、聚合归档完成 1804 次字节比较；独立 LICENSE/patch 与聚合入口另行核对 |

Desktop PDF 原件只读，输出位于隔离临时目录 `/var/folders/76/qx42kt5s3k91p4r9j5r0wkv80000gn/T/ccpg-desktop-pdf-final-bUt4pn`。两份 PDF 都保留 `needs-review`；受限 require 和原有 cMap 字体警告仍可见，不能据 Markdown 非空宣称语义完整。

浏览器使用隔离测试方案和模拟 CLI，没有访问真实云端。可见图片 fixture 已改成 640×360、7646 bytes；编辑器内部 1×1 传输用例不作为视觉可读性证据。

## 内部归档与 Desktop 加载

归档：`dist-release/dsh-harness-one-plugins-0.11.4-internal-delivery-r8.tar.gz`

- 大小：233347257 bytes。
- SHA-256：`66e743504b47fafd04da64f3cb01d230133530c42af96240247472afc016507c`。
- 日志：`/tmp/ccpg-scheme-delivery-r8-pack.log`。
- 已验证聚合 canvas 依赖及 Darwin arm64 原生二进制进入归档；scheme 中不包含开发文档、测试、authoring、用户材料或运行状态。
- Desktop profile 的 `dsh-harness-one` 链接指向仓库 `dsh-plugins/dsh-harness-one`，安装文件与归档一致。

2026-10-11 21:43（Asia/Shanghai）正常退出并打开 DSH Desktop Beta 2.0.17-beta.1。旧 main/Host 66137/66168 已退出，新 main/Host 为 34105/34138；Host 在 `127.0.0.1:43120` 监听，21:43:05.795 日志确认“8 个子插件已装配”。未修改 Desktop Runtime、provider、凭据或其他插件配置。宿主其他既有记忆/技能警告未在本轮处理，不宣称全宿主零告警。

重启前后原测试方案 state SHA-256 均为 `7170f2a8850d07c342cbe9657012ba4eafdf4786861906536ec6b25cff4b00c8`：revision 144、80 份材料、14 份成果、第 11 章 pending。已有项目仍保留固定规则，未强制迁移 r8、修改材料、提交正文或替用户确认。

## 遗留边界与继续验证

- 原目录原会话说“继续原方案，从中断处继续”，无需重新初始化。最后一章生成后核对“全文交付”；全部章节人工确认后验证飞书入口。
- 本次没有执行真实模型续跑、真实用户飞书文件夹/文档/附件写入或跨平台干净安装，隔离浏览器不等同于重启后 Desktop UI 验收。
- Word 转换尚未实现；当前交付支持图文 Markdown/ZIP 和飞书转换入口。旧成果没有原图时必须补真实原件。
- 自动问题评估报告 D-036 仍处于设计阶段；现有本地技术诊断可用，不冒称已实现自动报告/线上上报。
- 校验脚本曾假定聚合子目录有独立 LICENSE/patch，并碰到 tar 清单默认缓冲区限制；已按实际装配布局和足够缓冲区纠正并完整重跑，不能把首次校验失败当安装缺陷或略过。

无提交、推送、公共发布或真实云写。临时界面服务在验证结束后关闭；Desktop 保持运行供用户验证。
