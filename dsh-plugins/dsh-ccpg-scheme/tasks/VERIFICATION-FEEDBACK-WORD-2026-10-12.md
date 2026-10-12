# 本轮问题报告、Word 交付、规则装配与 Desktop 验证

日期：2026-10-12（Asia/Shanghai）。分支：`codex/ccpg-scheme-tdd`。本轮没有提交、推送或公共发布。

## 已实现并验证

- 本地问题记录：`.ccpg-scheme/validation/issues.json`、`reports/方案生成问题报告.md`，工具为 `scheme_validation_report` 和 `scheme_feedback`。原生请求失败、终止、状态和停止事件只观察，不改变 DSH 重试、章节 revision 或准备令牌。
- Word：正文通过固定 `docx` 与 `markdown-it` 生成，保留标题、列表、普通表格、链接和本地图片；复杂 HTML、缺图和远程图片明确失败，不静默丢内容。附件仍作为独立交付。
- CCPG CLI：当前用户只读候选/项目快照已接入，保存来源和时间并标记 `verified: false`；不自动选项目或把未核验字段绑定成权威材料。
- 规则：默认包为 `source-8073-internal-r9`，15 章、417 份资源，运行时技能位于标准 `rules/skills/*/SKILL.md`；修正了重复 `rules/rules` 装配问题。

## 验证结果

- `npm test`：退出码 0，全部单测通过。
- `sh dsh-plugins/build-web.sh`：退出码 0，双 base 构建通过。
- `node scripts/verify-plugin-packages.mjs`：通过。
- `node dsh-plugins/dsh-ccpg-scheme/test/packaging.test.mjs`：通过；额外检查根规则入口、15 个章节技能和 417 资源。
- 方案 Host：16/16 通过；Skills：3/3 通过；Word：4/4 通过；问题报告：7/7 通过；`git diff --check` 通过。
- 内部包：`dist-release/dsh-harness-one-plugins-0.11.4-internal-feedback-word-r9.tar.gz`
- SHA-256：`43c2dd1bbc513fef800239b91f58201ca569bf77de950698920afd745e958933`
- 包大小：239,224,456 bytes；463 个方案运行文件，源码/聚合包/Desktop 链接/归档共 1,852 次字节比较通过。归档内含 `docx`、`markdown-it` 和 `pdfjs-dist` 运行依赖，未发现方案状态、诊断、凭据或开发资料。

## Desktop

正常退出并重新启动 DSH Desktop Beta 后，Host 日志记录 `8 个子插件已装配`；新进程为 main `62987`，Host utility `63006`。链接安装目录的规则版本为 r9、15 章、417 资源，无多余 `rules/rules`。

真实方案 `/Users/linbiqiu/trae/项目质量方案测试` 在业务层保持 revision 151、84 份材料、15 份成果；重启后面板恢复，全文交付显示正文与附件、版本 151、附件 11 份，并提供 `下载 ZIP`、`下载 Word` 和飞书入口。当前仍有 6 个章节待人工核对，因此飞书总交付按钮按规则保持禁用；这不是章节未生成。

验证页面时 DSH 自身更新了 `.workflow-one/workflow-one.sqlite*` 会话持久化文件，并生成了一个章节目录 `.DS_Store`；未回滚用户文件。业务 `state.json` revision、材料和成果数量未变。之后继续运行时应以 DSH 自己的会话状态为准。

## 仍待用户验收

真实模型业务质量、扫描页多模态语义、CCPG CLI 字段/期间/权限口径及自动绑定、真实当前用户飞书云写与回读、Word 在本机 Microsoft Word/预览器中的排版、跨平台干净安装，均没有被结构测试替代。问题报告的自由文本只有基础脱敏，分享前请人工检查，不会自动上传。
