# 2026-10-10 验证记录

本文件保留同日各阶段证据。以最前面的收口记录为准；之后的归档 hash、项目进度与未实施描述属于阶段历史。

## D-037 原生文档读取修复（最新）

- 解析器 v5 与材料门禁已验证：材料 `27/27`、原生路由 `12/12`、核心 `34/34`、Host `13/13`、Skills `3/3`、规则编译 `15/15` 全部通过；覆盖纯文字 PDF/Office、可读图文、扫描/无可靠文字、未决项、来源变化、取消、软链接、篡改结果、原生图片能力和旧视觉进度兼容。
- 最新运行代码已通过全仓 `npm test`；`build-web.sh` 双构建、内部 `pack.sh internal-native-document-r4-20261010`、打包后 `build-scheme.sh --check` 和包契约通过（591 个聚合 npm 文件、4 个 client 工厂、8 个子插件）。最后文档修订期间再次运行上述六套专项，共 104/104、0 失败、0 跳过；未因纯文档修改重复全仓构建。
- 文档收口后再次执行全仓 `npm test`，exit 0；其中包含 `material-collection` 和 `material-routing` 两套原生链路回归。最终 bundle 校验、包契约、11 份开发文档的 29 个本地链接和 `git diff --check` 通过。
- 当前默认路径不强制逐图、不强制新子会话、不要求特定图片工具：普通文档由 DSH 原生文件能力与官方 Office/PDF Skill 读取；只有实际需要视觉语义时才交给配置的多模态模型。一个原件始终保存为一个可复用 Markdown 材料，无法确认的事实继续保持缺口并阻断必填输入。
- 官方 Office Skill 由宿主 rank 600 优先，插件内置官方原文、脚本和资源为 rank 601 后备；自定义 `office-docx`/`office-xlsx`/`office-pptx` 包装已删除。真实 SkillRegistry 回归确认来源与 resourceBase 正确。未安装 OCR，未修改 DSH Runtime。
- 新内部归档：`dist-release/dsh-harness-one-plugins-internal-native-document-r4-20261010.tar.gz`，233228023 bytes，SHA-256 `59b46a9e627b2af6597471686ed8a3b8f63fd9ba5c7656a20990dc259360ca47`。源码、本地 Desktop 链接目录、归档独立插件和聚合子插件的 459 个运行文件逐字一致；聚合 `client/index/patch` 一致。
- Desktop Beta 2.0.17-beta.1 于 2026-10-10 23:07:59（Asia/Shanghai）完成普通图标启动：`startup.run.completed`、`rendererStatus: healthy`；Host PID 12924 监听 `127.0.0.1:43120`，日志显示 8 个子插件装配。之前的 `DesktopDataDirectoryError` 属于旧启动记录，不是本次 healthy 启动。
- 原方案 `/Users/linbiqiu/trae/项目质量方案测试` 的受控迁移从 revision 50 到 51，仅替换已知旧材料指令并更新规则指纹。34 份登记材料、前两章 `submitted`、2 份成果及 12 个成果文件字节保持不变；项目业务规则仍为 `source-8073-internal-r2`，没有强制迁移到 r4。
- 本轮使用的完整测试输出见 `.superpowers/sdd/IMPLEMENTATION-PLAN/tests-native-document-r4-20261010.log`，打包输出见 `pack-native-document-r4-20261010.log`。归档一致性检查最初错误拼接了归档根路径，已按实际装配目录修正并重新检查通过。

## 验收边界

Mac 在本轮处于锁屏，无法进行新的 Desktop UI 点选检查；未调用真实模型解读用户材料、未连续生成全案、未执行真实飞书云写入。通过的是代码、原生 ToolRuntime、SkillRegistry、打包和宿主装配，不等于业务内容语义验收。旧会话中已经累积的图像历史不会被安装更新自动删除，超窗口时请在同一方案目录新开会话继续。

## 插件优先与成果面板收口

- 浏览器入口按最新要求暂缓并隐藏，优先原生成果面板，不新增运行控制按钮，不修改 DSH Runtime。
- 目录按业务 code 展示、按 order 排序；输入、必填决策、绑定、前置章节、输出及章内依赖、知识/模板/案例均展示。提交后保存必填决策，多角色资源进入全部对应分组。
- 内置知识按 references.inputIds 对应，显示“内置知识”和实际解析状态，不误报成缺少用户上传；不伪造绑定、不放松准备门禁。
- 真实 Desktop 发现窄面板按全窗口排三栏。改为容器宽度查询；原生客户端 harness 在 1440px 窗口下测试 575/850/1200px 面板分别为一/二/三栏，正文至少 320px、详情不越界。截图 `/tmp/ccpg-scheme-narrow-panel-fixed.png`。
- 新回归 client 19/19（新增知识测试先 RED 再 GREEN）；Host 11/11、core 31/31、ui-editor 3/3、skills 3/3 通过。本轮此前全仓 npm test 通过，最后展示修正后重跑 client；最终 pack 重新执行双构建与包契约。日志 `/tmp/ccpg-scheme-full-test.log`、`/tmp/ccpg-scheme-final-layout-pack.log`。
- 最新内部归档 `dist-release/dsh-harness-one-plugins-0.11.4-internal.tar.gz`，SHA-256 `de71a046cf73981a92c42a8b16655a1bbe303e43bd0d6f50e3f4fe40d17042e5`。Desktop profile 链接本地聚合目录，标准技能与资源随包；没有提交、推送、公共发布。
- 已完整重启 Desktop Beta 2.0.17-beta.1，确认 43120 Host 与 8 子插件装配。最后仅客户端修正，重新装配并刷新 renderer，保留用户正在下载材料的原生后台任务。
- 最后源码/安装聚合目录 449 个运行、Skill、规则文件逐字一致。刷新后的真实面板检查新 scheme-shell、内置知识标签、正文/详情宽度不超过面板，后台仍运行；截图 `/tmp/ccpg-scheme-real-desktop-final.png`。首次断言假设面板至少 320px，实际宿主分栏仅 282.5px，已改为核对正文占满可用宽度而非要求超过容器。
- 图像解析每次一页/一图，交给原生材料子任务，持久化并合成同源一个材料；主方案会话不接收图像。单张超大图仍可能超出模型窗口，真实多模态质量尚未验收。
- 完整 15 章执行、飞书正式发布、跨平台干净安装仍未验收。独立浏览器入口暂缓，不把候选页面测试当作正式交付。

## Desktop 测试缺陷修复（最新结果）

### 修复范围与有效证据

- 用户报告：`/Users/linbiqiu/trae/项目质量方案测试/缺陷反馈-dsh-ccpg-scheme-20261010.md`。只修改本仓库插件，不修改 DSH Runtime，不以旧平台验收。
- 准备令牌两处校验改为 JSON roundtrip 后 `isDeepStrictEqual`；顶层及嵌套键序、JSON 中省略的 undefined 不再造成误拒。值篡改、取消、会话不一致及材料/上游变化仍拒绝。真实 ToolRuntime 重建参数回归通过；具体真实 MCP 层如何重排尚未取证。
- 输入目录存在可索引文件且登记材料为空时，准备门禁提前拒绝；证据校验说明 source 必须是登记材料或成果 ID。全局 Skill、运行 AGENTS 和生成源要求先解析登记再准备；重复内部错误停止并报告，不让业务 Agent 查源码、调私有 HTTP 或绕过提交。
- 第 7 章以 `internal-supplement` 来源标记补单一正文，默认规则为 `source-8073-internal-r2`，15 章、417 份资源、0 编译 blocker。源业务表未定义本章输出，补充结构待业务验收；没有捏造固定模板或附件。
- 已有项目更新先校验旧规则完整性；无活动执行且目标章未产出时才允许原缺失输出的兼容补充。AGENTS 显式更新参与同锁操作，保存失败恢复旧文件；共用约束变化使已有成果 stale，材料与成果原件保留。
- 客户端仅在最新 snapshot 有 artifactId 时请求正文，覆盖空章零请求、草稿保留及首次成果同步；合成浏览器和真实 Desktop 面板检查已做。
- 修复后全仓 `npm test`、规定双构建、scheme bundle check、内部装配/包契约及内部打包通过。证据为仓库 `.superpowers/sdd/IMPLEMENTATION-PLAN/tests-defects-20261010.log` 和 `pack-defects-20261010.log`；打包日志包含超长构建警告行，应过滤后查看。
- 文档收口时新跑 core 31/31、Host 10/10、client 16/16，共 57 项通过、0 失败、0 跳过；包含规则/AGENTS 保存失败回退和真实工具参数传输回归。最后只有开发侧文档变化，未重复全仓测试或重打包。

### 最新内部包与本地安装

- 归档：仓库 `dist-release/dsh-harness-one-plugins-0.11.4-internal.tar.gz`，232549838 bytes，17148 entries。
- SHA-256：`448a317d4bf19e3ec3a5808e165ae1d87bf3bd79c5573e40406b0b48daf2e39f`。文档收口时重新计算并核对通过；较早章节的 hash 均为历史值。
- 源码、本地 Desktop 安装目录与归档中的 `lib/core.js`、`lib/index.js`、`lib/client.js`、`rules/AGENTS.md`、`rules/manifest.json`、全局 `ccpg-scheme/SKILL.md` 六项逐字一致。章节 Skill 与 417 份内置知识/模板/案例资源随 r2 默认规则分发。
- 本地 `desktop` profile 的 `dsh-harness-one` 链接仓库内部聚合目录。DSH Desktop Beta 2.0.17-beta.1 完整重启后，Host 43120、8 子插件装配及 renderer healthy 已检查；真实原会话与「方案成果」面板可见。
- 开发文档、authoring、local-data、用户材料/状态/凭据不进入内部安装包；公共包仍排除 scheme。未提交、未推送、未公共发布。

### 原项目进度与已知错误

- 原目录 `/Users/linbiqiu/trae/项目质量方案测试`、projectId `haiyin-quality-plan` 在受控规则更新时为 revision 7、第 1 章 interrupted、材料/成果为 0；原输入文件和 8095 字节草稿保留。
- 用户随后继续测试。2026-10-10 15:38（Asia/Shanghai）只读检查为 revision 24、登记材料 13 份、第 1/2 章 submitted、成果 2 份、第 3 章起 pending。只能据此说明已有两章提交，不能代替完整连续执行和业务质量验收；开发侧未发送生成指令或替用户提交/确认。
- `materials/notes/chapter-1-draft.md` 仍为 8095 bytes，mtime `2026-10-10T06:32:06.298Z`，未改。原会话和目录直接继续，不重复迁移或覆盖新状态。
- 诊断共 194 条；最新一条 `2026-10-10T07:31:50.320Z`（本地 15:31:50），`tool:material_parse` / `source must be a regular file`，规则 r2。解析接口只接受单文件；没有原参数，不能证明此次传入的是目录。目录应先枚举，再逐文件解析登记，保留此项待真实材料验收，不能声称重启后全无错误。

### 后续优化与未验收项

- 用户截图的业务编号/层级和输入依赖展示存在已核实缺口；当前没有独立浏览器成果页。按用户要求只记录，尚未实施，见 [成果页优化补充](RESULTS-VIEW-IMPROVEMENTS-2026-10-10.md)。
- 完整 15 章模型连续生成、原生停止/恢复、扫描页及复杂 Office 的真实多模态语义读取、第 7 章业务结构、CCPG CLI 自动项目取数、当前用户飞书正式发布及二进制附件仍未验收。
- 当前用户飞书写入须先明确目的地与意图；未在本轮云写。真实浏览器下载/ZIP、跨平台干净安装、长时间运行及跨轮取消补丁的第二次独立复审仍未完成。
- Office 渲染计页仍可能重复有界转换；视觉回执在进程内，重启或淘汰后可能需重读。第三方 dsh-memory 的 Python 3.9 语法问题未改。

## 历史阶段验证

- 分支：`codex/ccpg-scheme-tdd`，基于远程 `origin/main` 的 `de42d17`；未提交、未推送。
- 方案插件测试：最终回归通过，包含核心状态、原生 Host、材料解析/Office 转换与页面缓存、飞书契约、规则编译、打包边界和编辑器结构往返。
- 全仓 `npm test`：在标准 DSH 技能发现测试和编辑摘要修复后重新执行，exit 0，全部套件通过。
- `sh dsh-plugins/build-web.sh`：双前端构建通过。
- `sh dsh-plugins/build-scheme.sh --check`：通过。
- `node scripts/verify-plugin-packages.mjs`：内部包契约通过。
- `sh dsh-plugins/assemble-one.sh --public && PUBLIC_BUILD=1 node scripts/verify-plugin-packages.mjs`：公共聚合 130 files / 3 client factories，明确不含方案插件；随后已重新恢复内部装配并通过内部契约。
- `sh dsh-plugins/assemble-one.sh`：8 个插件内部聚合装配通过。
- `sh dsh-plugins/pack.sh 0.11.4-internal`：在标准技能、内部资源和打包后 SDK 软链修复后重建内部归档；未发布。
- 隔离 DSH Desktop/profile：方案成果页可打开；合成三章目录按自然顺序显示；正文编辑保存形成新版本；用户确认后显示 confirmed；下游显示 stale；未配置模型密钥、未调用真实模型或云端。
- 浏览器成果页：桌面视口和 390px 窄视口均检查；草稿冲突提示不覆盖用户文本；附件下载入口可见；Markdown 表格/图片/无序列表/有序列表/任务列表结构往返断言通过。UI harness 控制台无错误/警告；最终原生页未做重新过滤后的控制台断言，不以此前重启/重连日志作为干净证据。
- 原生人工操作通过 DSH command 通道，页面保存/确认没有新增第二套聊天或运行控制。
- `git diff --check` 及修改过的 shell 脚本 `sh -n`：通过。

## 历史内部归档（已被最新结果替代）

- 文件：集成仓库 `dist-release/dsh-harness-one-plugins-0.11.4-internal.tar.gz`。
- 字节数：232549449；归档条目：17148。
- SHA-256：`198a18d682e77cacd73c2b3edb1e21682aaf8967e80f777f0dbe0174beed2c6a`。
- 本轮在标准技能修正、内部资源同步、编辑摘要修复和 `pack.sh` SDK 软链恢复后重建；对归档中的 scheme `lib/core.js`、`rules/manifest.json` 和 `pack.sh` 与最终源码逐字比较通过。
- 运行规则、默认解析 Skills、Office MIT 与 PDF Apache 许可证均在归档；方案插件开发源码、过程文档、测试、authoring 和 `.superpowers` 排除。
- `pack.sh` 的 SDK 软链接检查通过；专门的 archive 回归覆盖真实 LibreOffice 包允许、SDK/悬空软链接拒绝和 staging 保留。文件清单检查未包含凭据 JSON、用户方案状态、项目/附件目录，已比较的第一方运行文件不含开发机用户路径；这不是对全部第三方二进制内容的敏感信息审计。
- 归档清单复查不包含 `local-data/`、`rule-review-generic-*/`、开发侧 `authoring/chapter-rules/`、过程文档或 `.superpowers/`。归档内默认规则已切换为 `source-8073-internal`，包含 15 个标准章节技能和 417 份内部测试资源；资源 permission 明确为用户授权的本地内部测试、禁止公共分发。

## 历史闸门（当前状态见最新结果）

- 没有真实多模态模型读取扫描页、图片或 Office 视觉内容；只验证了官方 `read_image` 结果凭据门禁，不冒充模型已读。
- CCPG CLI 目前只有规则能力映射/证据和运行 AGENTS 指引，自动项目取数工具尚未实现及验证；没有真实项目权限、字段、期间和口径验收。内部默认包是 source-8073-internal，除第 7 章输出定义缺失外无规则编译 blocker；这仍不等于真实业务生成验收。
- 已真实读取用户指定业务表及有权限的资源原件；没有执行成果云写或未确认目的地的发布。读取/export 下载不等于发布验收。
- 二进制附件没有确认的当前用户 CLI 上传/回读契约，发布会在审批前失败关闭；本地 Markdown/文本附录、hash manifest 和 ZIP 导出契约已验证。浏览器下载和 ZIP 的实际点击/字节保存未执行。
- 未在用户现有 Desktop profile 上改配置、安装或替换插件；隔离 profile 使用合成数据。
- 跨平台安装、实际用户权限、目标 Desktop 版本组合和真实升级保留仍需单独验收。
- Office 页面渲染请求目前会重复有界 Office-to-PDF 转换以计页，PNG 能复用；视觉凭据仅进程内每会话 512 条，重启/淘汰后须重读图片。这些限制未达到所有材料处理一次的理想目标。
- 最后跨轮取消补丁有失败测试及回归，但未再独立复审。

## 来源与章节 Skill 收口

- 来源快照：业务表 `MJ8ashBmrh67GMtoMRQcIbxJn7f` / `0gVCWf`，revision 8073；rich-text 引用、合并单元格和表信息保存于 `.superpowers/sdd/IMPLEMENTATION-PLAN/feishu-current/`，不同 revision 拒绝混用。
- 章节 Skill 编译聚焦检查：`node dsh-plugins/dsh-ccpg-scheme/test/build-rules.test.mjs`，14/14 通过。每章纳入业务处理规则、材料要求/来源、前置成果、章内输出依赖和模板引用，不只保留通用提示词。
- 收口后重新执行全仓 `npm test`：exit 0，全部单测通过；下载脚本 `node --check` 和缓存复跑均 exit 0。本轮未重建内部归档，当前来源候选仍未启用。
- L 列项目演练资源：49/49 下载，其中 38 项为项目材料引用、11 项为模板指针；模板不视为已填现场事实。单独保存在 `local-data/ccpg-scheme/project-materials/index.json`。
- 通用规则来源：112 项，111 下载、1 用户批准跳过、0 待下载失败；全部 25 份知识原件已下载。单独保存在 `local-data/ccpg-scheme/rule-sources/index.json`。
- 跳过项仅为“【XX项目】保洁岗位工作参考案例”；保留 permission_denied 错误和用户跳过理由。缓存复跑返回 downloaded=111 / skipped=1 / failed=0，没有重试授权或切换身份；不代表整体认证失败。
- 所有已下载原件及已有解析 Markdown 的 SHA-256 和目录边界检查通过；两个索引均被 Git 忽略，安装包清单不包含根目录 `local-data/`。
- 通用来源解析 complete=8 / needs-vision=102 / 未解析=1；未解析项为“8.5.1 客户服务场景与关键控制模板”，下载标题被当作后缀，原件已保存但解析器拒绝该后缀。项目演练资源 needs-vision=49。尚未执行真实多模态语义核验；PDF cMap 提示及 Office 视觉范围不能被下载成功覆盖。
- 用户随后明确要求把更新技能内置到本地内部插件并安装验证，因此 34 个知识资源以“本地内部测试、禁止公共分发”的 permission 编译进内部默认包；对应分发权 blocker 关闭。第 7 章缺失输出定义仍保留。

## 泛化章节技能与原生发现

- 新增开发侧人工泛化规则源 `dsh-plugins/dsh-ccpg-scheme/authoring/chapter-rules/`，15 章规则不再包含案例项目名、历史合同日期、具体已采集文件名或“第 N 行已采集”描述；输入编码、来源行和公司系统名仍保留在结构化契约中用于绑定与追溯。
- 重新编译私有候选 `local-data/ccpg-scheme/rule-review-generic-20261010/`：15 章、417 份随技能资源、274 个正文/原件引用；manifest hash、frontmatter、目录名和引用文件检查通过。规则区扫描未发现 `海印`、`深圳`、`2019-06-01`、`2022-05-31`、`已采集`、`第 N 行`、`SZ25` 等案例化规则残留；参考案例原文件标题保留溯源信息。
- 资源目录和文件名改为来源标题的可读名称，重复标题追加来源行，不再以 16 位 hash 作为目录/文件名。`download-source-resources.mjs` 缓存复跑返回 111 downloaded / 1 skipped / 0 failed。
- `node dsh-plugins/dsh-ccpg-scheme/test/build-rules.test.mjs`：15/15 通过，覆盖泛化规则替换案例规则、标准 frontmatter、资源相对链接和 manifest hash。
- `node dsh-plugins/dsh-ccpg-scheme/test/host.test.mjs`：8/8 通过。新增测试使用真实 `@deepseek-ai/dsh-skill` 与 `dsh-skill-filesystem`，确认项目技能来源为 `project-dsh`、model-invocable、资源基准为方案目录 `.dsh/skills/<name>`。
- 用 8073 泛化候选创建临时专用方案目录并挂载真实 DSH SkillRegistry/filesystem：15/15 章节技能全部被发现，`ccpg-chapter-1` 可按需加载且 `resourceBase` 指向其技能目录。此验证未调用真实模型生成正文。
- 内部默认包校验：15 个技能目录/`SKILL.md`、417 份资源、274 个相对引用全部存在；manifest/hash 校验通过；规则区无案例项目名、历史合同日期、“已采集”或源表行号描述。第 7 章输出缺失继续硬阻断。
- 最终补充：`sh dsh-plugins/build-scheme.sh --check`、内部/公共包契约、`sh dsh-plugins/assemble-one.sh`、`sh dsh-plugins/pack.sh 0.11.4-internal`、`git diff --check` 和四个规则/资源脚本 `node --check` 均通过。打包后 scheme DSH SDK 软链保留，Host focused test 8/8 通过。

## 本地 DSH Desktop 安装

- 全局 `dsh plugin --profile desktop` 被 DSH 0.2.0-rc.2 拒绝，原因是 `desktop` profile 由 Electron 独占管理；该拒绝是预期保护。
- 改用 DSH Desktop 自带 packaged dsh runtime 的 `manageDesktopProfile` 通道安装本地 `dsh-harness-one`。首次安装被 Desktop 供应链策略拦截（既有 `billion-context@0.1.189` 与 `dsh-remote@0.8.41` 发布时间小于 minimumReleaseAge）；随后仅对这次显式本地安装使用进程级 `--config.minimumReleaseAge=0`，安装成功，未改用户全局 pnpm 配置。
- `~/.dsh/profiles/desktop/package.json` 的 `dsh-harness-one` 依赖指向本地聚合目录；profile 内可见 `source-8073-internal`、15 个技能目录和 417 份资源。
- DSH Desktop Beta 默认 channel home 为 `~/.dsh-beta`，而当前 profile 在 legacy `~/.dsh`。已按 Desktop 原生 `data-directory/state.json` 格式固定 activeHome 为 `/Users/linbiqiu/.dsh`，并撤销临时 `launchctl setenv DSH_HOME`。
- 正常重启 DSH Desktop 后，Host 监听 `127.0.0.1:43120`，lifecycle 记录 `startup.run.completed`、`rendererStatus: healthy`；该验证在无临时环境变量的普通图标启动路径下完成。未调用真实模型生成章节，也未执行云写。
- 现有第三方 `dsh-memory` 插件在本机 Python 3.9 下因 `str | None` 语法反复报错；该错误与 scheme 插件无关，未修改用户其他插件。

## 运维诊断

- 新增方案目录 `.ccpg-scheme/diagnostics.jsonl`：记录原生工具、人工 command、HTTP API 与工具 guard 异常；字段含时间、入口、项目/章节、错误码、脱敏消息、插件版本、规则版本。
- 不记录正文、材料内容、原始参数、token 或凭据；当前文件超过 1MB 轮转为 `.1`，仅保留两份。
- `project_status` 和页面状态接口返回最近 20 条；运维可直接读取 JSONL 或后续接入同格式上报通道。
- Host 测试新增本地诊断与轮转断件；`node dsh-plugins/dsh-ccpg-scheme/test/host.test.mjs` 9/9 通过，覆盖工具错误、HTTP 错误和轮转。全仓 `npm test` 在诊断改动后 exit 0。
- 诊断实现后重新执行 `pack.sh 0.11.4-internal`；归档内 `lib/index.js` 包含 `diagnostics.jsonl` 逻辑，`lib/index.js`、`rules/AGENTS.md`、`rules/manifest.json` 与源码逐字一致。DSH Desktop 普通重启后 renderer healthy。

## 业务用户入口简化

- 用户进一步确认对话优先：页面不应承担开始按钮。首次使用页面改为只读空状态「方案尚未开始」；初始化由对话意图触发。
- 新增标准全局 `ccpg-scheme` Skill，按“生成物业服务方案 / 开始项目质量计划 / 继续 / 上传材料 / 飞书材料清单”等意图触发；材料支持会话附件、本地文件/目录、飞书文档/Wiki/表格、飞书清单和已验证 CCPG CLI。
- 飞书清单处理规则：先读清单、抽取真实资源链接/标识，再逐项用当前用户飞书能力抓取并登记来源、版本与完整性；清单行或链接标题不当作内容。
- 运行 `AGENTS.md` 要求把当前会话附件复制到内部 `materials/input` 后解析绑定，但该目录、工具名、Skill 路径和章节编码不对用户暴露。必填项由插件 `chapter_prepare` 门禁强制校验。
- 聚焦测试：client 15/15、skills 2/2、rules 15/15、host 9/9 通过；全仓 `npm test` exit 0。
- 对话优先、灵活材料入口、CCPG CLI 初始化和压缩包材料规则加入后的最终归档为 232549449 bytes / 17148 entries / SHA-256 `198a18d682e77cacd73c2b3edb1e21682aaf8967e80f777f0dbe0174beed2c6a`。

## Desktop 插件消失故障修复

- 现象：用户看不到原 Workflow One 入口和「方案成果」。Host 日志显示 `dsh-harness-one failed to import`，根因是从应用目录解析不到 `cron-parser`。
- 原因：`desktop` profile 通过本地 link 指向源码聚合目录；此前只保证归档内实体依赖，未把依赖实体化到本地聚合目录。
- 修复：`assemble-one.sh` 新增 `materialize_runtime_deps`，内部包复制 scheme 解析依赖与 orchestrator 运行依赖，公共包复制公共运行依赖；包契约逐项解析本地聚合包依赖。
- 验证：`assemble-one.sh`、`assemble-one.sh --public`、内部/公共 `verify-plugin-packages.mjs`、`dsh-ccpg-one/test/install.test.mjs` 均通过。DSH Desktop 重启后日志显示 `dsh-harness-one: 8 个子插件已装配`，renderer healthy，Host 43120 正常监听。
- 修复后重新打包；归档内包含 `assemble-one.sh` 的 `materialize_runtime_deps`，以及聚合包本地 `node_modules` 中的 `cron-parser`、`ajv`、`@deepseek-ai/libreoffice-kit` 等实体依赖。归档与源码逐字一致性检查通过。

## CCPG CLI 初始化

- 读取用户提供的飞书手册 `HvrndidqwoM4pbxeEW4ciBO5nVe` revision 169，提取一键安装、必做更新、`config init --agent-code skill_hub_einwin`、飞书登录与网络排障边界。
- 新增 `ccpg_cli_status`：返回 installed/configured/userConfigured/authRequired/version/brand/appId，不返回 appSecret。
- 新增 `ccpg_cli_setup`：已安装则执行 `ccpg-cli update --json`；未安装且主机为 Linux amd64/arm64 时执行官方一键安装，随后更新并按需初始化配置；其他平台返回 manual-install，不猜命令。结果如需用户授权，返回 `ccpg-cli auth login`。
- 全局 `ccpg-scheme` Skill 新增 `references/ccpg-cli.md`，指引先检查状态、仅在用户要求或业务必需时准备，并把飞书集团账号授权和网络问题转成用户/运维步骤。
- 测试：`ccpg-cli.test.mjs` 3/3 覆盖脱敏状态、已安装更新/登录提示、非 Linux 不执行一键安装；skills 2/2、host 9/9 通过。本机实测当前 CLI 更新至 1.2.16，配置和用户授权均为 ready。
- 装配契约强制聚合包包含 `lib/ccpg-cli.js`；首次打包曾漏该文件，已修复为单包复制并重新打包。归档源码一致性检查覆盖 host、client、CCP CLI runtime、全局 Skill、reference、运行 AGENTS 和 manifest。DSH Desktop 重启后 8 个子插件装配、renderer healthy。

## 证据入口

- `.superpowers/sdd/IMPLEMENTATION-PLAN/task-final-fix-report.md`
- `.superpowers/sdd/IMPLEMENTATION-PLAN/review-final-report.md`
- `.superpowers/sdd/IMPLEMENTATION-PLAN/native-test-home`（隔离、可删除的本地测试 profile）
- `dsh-plugins/dsh-ccpg-scheme/tasks/ACTIVE-PLAN.md`
- [最终复审与修复裁决](FINAL-REVIEW-2026-10-10.md)

以上是验证记录，不是业务规则批准或生产发布批准。

## 材料视觉解析收敛验证

- 根因：原执行把约 547k token 的图片连同主会话历史组成约 687k token 请求，超过模型 204k 上限，最终触发 `preflight_compress_failed`；这是插件材料处理机制问题，不是用户配置问题。
- 机制：`material_visual_batch` 每次只返回同一材料下一批最多 4 张图片/页面，由新的 DSH 原生子智能体读取；`material_complete_visual` 校验批次路径、同会话 `read_image` 回执、源文件与图片 hash，逐批保存后合并为同一最终材料。
- 恢复：解析进度保存在方案目录；进程或会话重启后从下一未读图片继续。解析器版本 2 会让旧登记材料在首次视觉批次请求时重新解析，保留已有章节 1/2 和项目状态。
- Office：XLSX 的 `xl/media/*` 已提取为同一工作簿的视觉输入，不再永久标为不支持；DOCX/PPTX/PDF 同样保持一源文件一材料。
- 最新专项证据：`materials.test.mjs` 17/17、`host.test.mjs` 11/11、`skills.test.mjs` 3/3；`build-scheme.sh --check` 和 `git diff --check` 通过；Desktop PID 35351 监听 `127.0.0.1:43120`。
- 最新内部归档：`dist-release/dsh-harness-one-plugins-0.11.4-internal.tar.gz`，SHA-256 `dc5efa959ea4cfa6863f39a5a5daec0abdb6b6d520f522d5a5b66ab38b550b42`；归档包含 scheme host、材料解析器以及 PDF/DOCX/XLSX/PPTX Skills。
- 未验证：尚未在真实模型会话完整跑完 13 份材料的多模态解析，也未证明第 3 章已成功绑定最终材料。测试时应继续现有 DSH 会话，不手工改写项目 state。

## 飞书材料清单自动采集

- 用户本次链接仅说明输入形式；较早误读两个小范围后已经停止，未下载引用材料。当前实现及验证全部使用 `example.feishu.cn` 模拟清单和写入临时目录的模拟 CLI，没有真实云读取/下载/写入。
- 新工具 `feishu_collect_materials` 通过当前用户 `ccpgLarkUserCli` 及显式 `--as user`，将清单中的原件保存到方案内 `materials/input/飞书材料/`，完整清单保存在 `materials/fetched/飞书材料清单.json`。支持富链接/文档引用/公式、去重、可读命名、校验复用、待完成导出续查和逐项失败记录。
- 清单行列覆盖和读取版本必须一致；截断、漏列、缺行及列表变化拒绝按完整清单处理。软链接越界拒绝，活跃采集锁保留，已结束进程的采集锁可恢复。工具回传文件、忽略项和无链接项各最多 100 条，完整内容留在磁盘索引。下载只登记 pending，之后复用既有解析工具。
- 本地 CLI fallback 原来忽略 cwd，导致相对文件路径保存到 Host 工作目录；新增失败测试复现并修复为 spawn 传入 cwd。默认解析和发布调用方无需另建 CLI 客户端。
- RED：漏列覆盖、遗留锁和本地 cwd 的新测试在修复前失败；运行 Skill 的自动入口/示例边界断言也曾失败。GREEN：采集测试最初 5/5；增加读取版本变化场景后，全仓执行该套共 6 项通过。Skill 3/3、Host 12/12、Desktop/local CLI runtime 回归通过。打包后 Host 12/12 再次通过，确认依赖软链恢复后原生工具仍能挂载。
- `npm test` exit 0；`pack.sh 0.11.4-internal` exit 0，包含规定 `build-web.sh` 双构建、scheme/client 构建、聚合装配、实体依赖和归档检查；`verify-plugin-packages.mjs` exit 0（593 个聚合包文件、4 个 client 工厂）。构建仍有既有的大块/inline-worker URL 警告，未扩大本任务处理。
- 当前归档 `dist-release/dsh-harness-one-plugins-0.11.4-internal.tar.gz`，SHA-256 `53702fd05d3781d67ce290423d0e5c19a364d11b1870a33eaddbb910f6b74587`。五个关键文件（采集 helper、scheme host、对话 Skill、运行 AGENTS、lark-auth）在源代码、Desktop 当前链接目录和归档中逐字一致。
- 没有重启或向用户 Desktop 会话发送消息，没有改用户方案目录或强制迁移规则。新增工具仍须正常完整重启 Host 后加载，不能把磁盘同步当成当前进程热加载。真实账号权限/下载、多模态语义质量、完整生成与正式飞书发布仍未验收。
- 原始日志：`.superpowers/sdd/IMPLEMENTATION-PLAN/tests-feishu-list-20261010.log` 和 `pack-feishu-list-20261010.log`。

## 知识依赖展示分类修正

- 用户要求内置知识只显示在知识依赖，不重复列作本章输入。共享展示 helper 按 reference.roles 和 inputIds 过滤项目输入；不改 Skill、manifest、核心校验或用户项目 state。资源缺失和待视觉解析仍在知识分组展示，多用途资源仍保留各自角色。
- RED：更新后的分类与标签断言在修复前有 4 项失败。GREEN：client 20/20，包括未下载知识、多用途资源、名称含“知识库”的真正项目输入及已绑定材料状态；内置 15 章定义核对通过，第 4 章保留 2 项项目输入与 8 项知识资源。
- 合成原生客户端浏览器核对：知识只出现一次，位于「知识依赖」，保持「待视觉解析」；「本章输入」仅有已绑定现场材料。320/768/1024/1440px 无横向溢出，浏览器无 error/warn，键盘 Tab 可达章节按钮。截图为 `.superpowers/sdd/IMPLEMENTATION-PLAN/knowledge-display-20261010.png`。这是客户端隔离验证，不是实际 Desktop 新界面验收。
- `npm test` exit 0；`pack.sh 0.11.4-internal` exit 0，含规定双构建；`build-scheme.sh --check` 与 `verify-plugin-packages.mjs` 通过（593 文件、4 工厂）；打包后 Host 12/12。日志为 `tests-knowledge-display-20261010.log` 和 `pack-knowledge-display-20261010.log`。
- 内部归档 SHA-256：`6ddb152730e7efd2306c37a4bbf0a612519cfb77fe9f16c40704959ff9600149`。scheme client/browser、manifest 和运行 AGENTS 在源码、Desktop 链接的安装目录及归档逐字一致；聚合 client 也与归档一致。
- 未访问飞书示例，未更新用户方案目录，未刷新或重启正在使用的 Desktop，未发送生成指令。临时浏览器与 UI harness 已关闭；实际 Desktop 页面待正常重新加载验证，真实材料语义解析与完整方案生成不属于本次分类验收。

## 文档路由与原生成果读取最终收口

以下记录覆盖本页较早的四张批次、未重启及默认规则 r2 状态；原用户方案仍保持 r2，不强制迁移。

- 最新全仓 `npm test` exit 0，所有套件通过；日志 `tests-material-routing-final-20261010.log`。打包后 Host 13/13、原生材料路由 6/6，零失败、零跳过；后者用真实 DSH ToolRuntime/FileSystem/AttachmentStore，覆盖纯文字不传图、视觉缺口、旧记录复用、权限/能力/取消、单子会话单项、原生冻结参数及回执门禁，不调用真实模型。
- PDF 解析版本 3 将图像、矢量、批注和不可靠文字层页作为视觉覆盖；纯文字 PDF/Office 直接完成。统一 `material_visual_read` 封装原生附件传输，配置的多模态模型负责解读，业务模型不再选额外图片工具。结果马上持久化，一份原件形成一份完整 Markdown；主会话复用，已完成内容不重复处理。
- 原生 Remote 使用官方 Typert Registry/Gateway：状态、正文和导出只读，编辑/确认仍由原生命令执行。活动 Session 不存在时用原生 `sessionPersistence.stat` 获取 header/cwd；未启动 Agent，未读取全部会话历史。真实 Gateway 调用、冷会话、不接受任意 cwd、无项目、取消及读取不改 state 均有专项。
- `sh dsh-plugins/pack.sh 0.11.4-internal` exit 0，包含规定 `build-web.sh` 双构建、scheme/client 构建、聚合装配、依赖实体化与归档 smoke；`build-scheme.sh --check`、`verify-plugin-packages.mjs`（593 文件、4 个 client 工厂）及 `git diff --check` 通过。
- 最新归档为 `dist-release/dsh-harness-one-plugins-0.11.4-internal.tar.gz`，233224261 bytes，SHA-256 `0aedc2f926f9f73f799179f3a2c0cadcdbad10a9ea6ee2b9ead099c94d0954f8`。源码、Desktop 链接目录、归档独立插件和归档聚合子插件的 462 个运行文件逐字一致，聚合 client 和顶层 patch 一致。临时检查最初误假定聚合子目录有独立 patch；核对装配脚本后修正对象并重新通过，临时解包目录已清理。
- `desktop` profile 仍指向仓库 `dsh-plugins/dsh-harness-one`。北京时间 20:53:52 正常重启完成，Desktop Beta 2.0.17-beta.1 的 lifecycle 为 `startup.run.completed` / `rendererStatus: healthy`，Host 日志显示 8 个子插件装配并监听 43120。
- 实际 Desktop 原会话无需先发消息即加载成果：15 个章节使用业务编号，8.1–8.5 正确；第 4 章两项项目输入、前置第 3 章、输出项/模板/案例及八项知识依赖可见，知识没有重复列作项目输入；第 1 章已保存正文、成果 ID 与章节版本实际可见。未点击保存/确认或发送生成指令。
- 原项目只读状态仍为 revision 35、27 份材料、第 1/2 章 submitted、其余 pending。未改其材料、规则、成果或进度。默认内部包为 `source-8073-internal-r3`，内置标准 PDF/Office/方案 Skills、章节资源及运行 AGENTS。
- 未验收：真实模型多模态语义、第 3 章材料绑定、完整方案、飞书正式发布、真实浏览器下载及跨平台干净安装。隐藏/不支持 Office 部件仍需明确补充，不能把管线通过当成所有文件语义已读。独立浏览器入口继续暂缓。没有 commit、push 或公共发布。

## 用户要求的再次打包与反馈机制设计

- 本次新增内容只为问题记录/评估设计文档，无新运行行为。设计状态 Proposed，未将自动报告、模型失败采集或业务反馈写成已上线。
- 再次执行 `pack.sh 0.11.4-internal` exit 0，包含规定双构建、解析依赖与聚合装配；日志 `pack-validation-feedback-20261010.log`。打包后 Host 13/13，零失败/跳过；日志 `host-validation-feedback-20261010.log`。`build-scheme.sh --check`、包契约（593 文件、4 个 client 工厂）和 `git diff --check` 通过。
- 新归档 233219967 bytes，SHA-256 `182ff9b689b79fd7db4e811f7900308b025d159a7e91b904e3d710e4811b380e`，仍位于 `dist-release/dsh-harness-one-plugins-0.11.4-internal.tar.gz`。源码、Desktop 安装目录与归档的 462 个运行文件及聚合 client/patch 一致；DSH profile 链接已同步到当前聚合目录。
- Host PID 55960 仍监听 43120，最新启动记录为北京时间 20:53:52 healthy。本次 Mac 锁屏，Computer Use 无法继续检查，未再次重启或声称本次重新完成界面验收；之前修复版真实 Desktop 验证仍有单独记录。当前运行代码没有新增行为，不能把设计文档当新功能加载。
- 用户方案只读检查仍为 revision 35、27 份材料、前两章 submitted，其余 pending；没有发送生成指令、改写材料或确认正文。
- 用户审阅入口：`VALIDATION-FEEDBACK-DESIGN-2026-10-10.md`。本次未重新运行全仓测试，运行代码未变；最新全仓通过证据在上一节，本次补跑安装/宿主相关验证。真实模型全案和飞书正式发布仍未验收。
