# 原生文件输入与材料解析复核

日期：2026-10-10。状态：用户随后明确要求修改修复，D-037 已实现、验证、内部打包并安装重启。本页先保留调查证据，再记录当前交付；真实模型语义及 r4 界面尚未验收。

## 用户意图

插件获取材料后，应像用户手动上传文件一样交给 DSH 原生智能体，使用已配置模型和标准文件技能处理。用户无需安排拆图、视觉批次或子会话。Word、Excel、PDF 不应仅因格式或包含图片，就进入逐图视觉流程。

原文、必要业务图片及表格仍须完整处理并保存；导出姓名/时间水印不作为业务事实。不能以简化流程为由遗漏正文图片里的必要信息。

## 已核实的事实

直接读取并执行当前 Desktop 自带的 `@deepseek-ai/dsh-llm/lib/types/content.js`：

- `projectFilesToText` 将通用 file 块转换为 text 块，其中包含原件的只读路径、名称、大小和摘要。
- DOCX、XLSX、PDF 的三次投影断言均通过；输入文件块未被修改。
- 图片块不经过这个通用文件投影，保留原生图片块；第四项断言通过。
- 实际请求边界的 `fileHandleText` / `projectFilesToText` 不把通用文件原始字节交给模型服务商。手动上传与插件提供通用附件都受到该宿主契约约束。
- 当前 Desktop 的官方 `office-docx` / `office-xlsx` 技能使用宿主提供的 Python 文档库。Excel 数据/公式任务不要求视觉检查，Word 仅在要求图片/PDF 交付或有具体版面问题时渲染。

本机核对位置：

- `/Applications/DSH Desktop Beta.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-llm/lib/types/content.js`
- `/Applications/DSH Desktop Beta.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-llm/lib/index.js`
- `/Applications/DSH Desktop Beta.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-skill-office/assets/office-docx/SKILL.md`
- `/Applications/DSH Desktop Beta.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-skill-office/assets/office-xlsx/SKILL.md`

同时核对本机全局 DSH 安装附带的官方 `dsh-attachment/README.md`，其中明确通用文件在模型请求中表示为可供文件工具读取的路径。本机路径仅为调查证据，不能写成其他用户的安装前提。线上源码页面本轮未取得可引用内容，不据此声称核对远端最新行为。

## 调查时的偏差（已修复）

`lib/materials.js` 仍将 Office 内的非水印图片或未支持部件统一设为 `needs-vision`，PDF 检测到绘图或批注也进入视觉门禁。`lib/index.js` 和 `skills/references/material-reading.md` 又要求每项创建新原生子会话并留下传图回执。这使“提供文件给原生智能体”变成额外的业务编排，不是手动上传的必要步骤。

`read_image` 的作用是把本地图片通过原生附件能力交给当前多模态模型，并不是 OCR 或第二个识别模型。但原生存在这个工具，不证明每份文档或每个内嵌图片都应调用它。

## 调查时的修正范围

1. 材料接入复用原生附件、文件能力和标准 Office/PDF 技能；插件保留材料来源、结果落盘及章节绑定，不新增模型调用循环。
2. 内容读取与图片/版面检查分开：有图片不等于全文必须视觉读取；正文图片保留，必要图像信息按需由当前多模态模型读取。不能把未知内容直接改成已完成。
3. 移除普通文档默认逐图、新建子会话的强制要求；大材料的安全处理仍需验证原生能力，不能再次把大量图像堆入主会话。
4. 原件及有效解析结果复用，一个源文件仍对应一份材料；不修改已有章节成果，不盲目清理用户材料或会话历史。
5. 修正必须同步调用方、核心绑定校验、技能、运行规则、缓存兼容和回归测试，再进行内部打包、安装及真实 Desktop 验证。

调查阶段只记录上述范围，未实施；随后修复结果见下节。D-037 替代 D-030/D-034 的默认强制视觉步骤；原件保存、不可猜补、来源校验和已解析结果复用继续有效。未宣称当前模型接口支持直接接收 Office/PDF 原始字节。

## 调查阶段验证边界

已运行：当前 Desktop 原生投影函数四项断言，以及本机官方包代码、README 和技能对照。

未运行：真实模型文件解读、全案生成、插件全仓回归、重新打包安装和 Desktop 重启。投影函数通过只证明传输行为，不证明材料语义解析质量。

## 当前实施与安装结果

- 解析器 v5：纯文字为 `complete`；可读图文及未支持部件为 `needs-review`，按文档核对；扫描/无可靠文字为 `needs-vision`，必要内容用原生多模态。保留精确文字、原件和业务图片，仅过滤结构可识别的姓名/时间装饰水印。
- `material_complete` 校验源 hash、工作区 Markdown、取消信号和可读结果，保存整件核对说明与 `unresolved`；缺口仍阻断必填输入。允许原生图片工具和同一会话，不要求图片回执或新子会话。旧视觉工具兼容部分已开始的进度，取消或策略拒绝不能留下有效回执。
- Office 直接使用包内官方原文、脚本和资源，rank 601 后备；已用真实 SkillRegistry 验证宿主 rank 600 官方技能优先。删除三份自定义 Office 包装技能；PDF 按只读任务适配官方提取方式，不安装 OCR/额外渲染器。
- 编译器、默认运行 AGENTS、全局 Skill、材料 reference、核心门禁及页面状态标签同步。默认规则 `source-8073-internal-r4`，15 章业务定义不变。
- 原项目仅替换已知旧材料指令，验证旧指纹、拒绝活动章并支持保存失败回退。revision 50 -> 51，34 份材料、前两章 submitted、2 份成果及 12 个成果文件字节保留；旧业务 manifest/章节 Skill、材料、成果、确认对象未改，未强制激活 r4。

## 当前验证证据

- 材料 27/27、原生路由 12/12、核心 34/34、Host 13/13、Skills 3/3、规则编译 15/15 通过；全仓 `npm test`、规定双构建及打包通过。覆盖原生工具权限/能力/取消、来源变化、软链接、已完成结果篡改、未决项门禁及迁移回退。
- 内部包：`dist-release/dsh-harness-one-plugins-internal-native-document-r4-20261010.tar.gz`，233228023 bytes，SHA-256 `59b46a9e627b2af6597471686ed8a3b8f63fd9ba5c7656a20990dc259360ca47`。源码、Desktop 链接目录、归档独立插件和聚合子插件的 459 个运行文件一致，聚合 client/index/patch 一致。
- Desktop Beta 2.0.17-beta.1 于 23:07:59（Asia/Shanghai）完整重启，Host 日志显示 8 子插件装配；lifecycle `startup.run.completed` / `rendererStatus: healthy`。当前仍使用本地聚合链接，不修改 Runtime 或发送业务生成指令。
- Mac 锁屏，无法检查本次界面；未调用真实模型解读材料或生成全案。保存和门禁校验不能证明模型理解正确。旧会话已积累的图片不会被安装更新移除，超窗口时新会话指向同一方案目录继续，已有结果复用。
