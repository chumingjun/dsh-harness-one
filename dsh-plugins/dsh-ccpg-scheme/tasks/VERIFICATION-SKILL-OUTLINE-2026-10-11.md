# 标准技能与成果目录修复验证

日期：2026-10-11，Asia/Shanghai。开发分支：`codex/ccpg-scheme-tdd`。本记录覆盖本轮修复，不代表全部产品功能或真实业务质量已经验收。

## 实际变更

- 初始化沿用根 `AGENTS.md`、`.dsh/skills/<name>/SKILL.md` 和标准 frontmatter。`chapter_prepare` 明确返回当前章原生技能名、路径和来源；兼容替换仍校验接口、资源和活动执行状态。
- 标准章节技能要求清洁正文、复用已解析材料及按章节取得实际需要的知识原文。法律汇编若只有名称清单，仍视为索引，不能冒称法律全文；权限或工具不足保留缺口。
- 正文小节和附件共用自然编号目录，附件标记类型；输出名称移除内部 ID 和重复编号。全文交付时才合并正文、分别交付附件。
- 预览与富文本编辑共用占位识别；编辑器通过既有 ProseMirror decorations 显示占位和人工核验小节，不将高亮标签写入 Markdown。Markdown 源码编辑保留 textarea，由章内事项列表辅助定位。
- 第 7 章内部补充由 `authoring/output-supplements.json` 显式编译，仅补空输出并拒绝冲突，记录 provenance。默认规则为 `source-8073-internal-r7`：15 个章节技能、417 份资源、零编译 blocker。输入输出接口和资源清单/hash 保持；内部补充仍待业务验收。

## 测试和构建

最新代码改动后执行：

| 验证 | 结果 |
| --- | --- |
| `npm test` | exit 0，全部单测通过 |
| `sh dsh-plugins/pack.sh 0.11.4-internal-skill-r7` | exit 0，包含规定双构建、scheme 构建、装配和依赖安装 |
| `sh dsh-plugins/build-scheme.sh --check` | exit 0，产物与源码构建一致 |
| `node dsh-plugins/dsh-ccpg-scheme/test/host.test.mjs` | 15/15，通过，零失败/跳过 |
| `node dsh-plugins/dsh-ccpg-scheme/test/skills.test.mjs` | 3/3，通过 |
| `node scripts/verify-plugin-packages.mjs` | 通过；聚合 592 文件、4 个 client factories |

全仓日志：`/tmp/ccpg-skill-outline-tests-20261011.log`。打包日志：`/tmp/ccpg-skill-outline-pack-20261011.log`。记录中的测试数字只适用于对应验证面。

## 浏览器验证

使用隔离原生客户端 UI harness，并非运行用户 Desktop 或调用真实模型。

- Editor 自检 14 项均 true：占位高亮、code 排除、人工事项对应 heading、显示装饰不序列化、已解决内容高亮消失，以及表格、图片、任务/有序/无序列表往返保留。
- 实际编辑界面显示待确认占位和 8.1.1/8.1.2 核验小节标记。修改、保存、重新加载后版本为 2，表格、图片和待确认内容保留。
- 附件中的“待确认事项”原文未被正文处理误删。
- 320/768/1024/1440px 宽度下，插件 `.scheme-shell` 无横向溢出；测试页的长 JSON 自检输出不属于插件布局。
- 浏览器 console error/warn 为空。最新真实 Desktop 界面仍需用户完整重启后核对。

## 内部归档和安装一致性

归档：`dist-release/dsh-harness-one-plugins-0.11.4-internal-skill-r7.tar.gz`。

- 大小：233311132 bytes。
- SHA-256：`ce55dee025ba827c2485771284f270ff88df8829d07bd591bad38194a6da3ca1`。
- 核对 460 个运行文件，共 1840 次字节比较：源码、工作区聚合、Desktop 链接、归档独立插件与归档聚合对应内容一致。
- 聚合 client/index/patch/package 亦一致；归档不包含用户材料、状态、凭据、诊断、开发任务、authoring、src/test/docs、local-data 或 `.superpowers`。
- Desktop link：`~/.dsh/profiles/desktop/node_modules/dsh-harness-one` 指向当前仓库 `dsh-plugins/dsh-harness-one`。磁盘默认规则已经为 r7。

运行 Host 会缓存模块。此次未重启或刷新用户 Desktop，因此磁盘安装一致不等于运行进程已加载新版。用户可完整退出再打开 Desktop，回到原方案目录，在原生会话中说“继续原方案”；不需要重新初始化。

## 原生加载与用户进度

只读解析真实原生轨迹：2465 records，14 个去重 Skill 调用，覆盖 12 个章节技能（4/5/6/7/8.1–8.5/9/10/11），另有 9 个 references 读取调用。原生记录类型是 `tool-call`。该证据证明加载/读取，不证明每条规则都遵守；本轮没有真实外部法律原文检索。

收尾只读核对 `/Users/linbiqiu/trae/项目质量方案测试`：

- revision 144；80 份登记材料、14 份 artifact。
- 第 1–10 章（包括 8.1–8.5）submitted，第 11 章 pending，无准备 token。
- 项目固定规则仍为 `source-8073-internal-r6`，本轮未迁移技能、覆盖正文、修改状态或发送生成指令。

## 尚未验收

真实模型全案质量、逐条知识/规则遵守、真实法律原文增量获取、当前用户飞书正文/附件上传与回读、跨平台干净安装及兼容替换技能，均不能由以上测试代替。D-036 自动反馈报告仍是设计，本地诊断已经实现；CCPG CLI 自动业务取数仍待后续实现/验收。浏览器独立入口按用户指令暂缓。

没有提交、推送、公共发布、真实云写、访问用户示例链接、重启 Desktop 或改动旧平台。
