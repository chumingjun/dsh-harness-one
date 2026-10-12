# 方案生成必要插件核查

2026-10-12；以当前仓库、Desktop profile、宿主安装包和真实会话记录为证据。未复制本机 profile 的所有插件，未删除用户自行安装的插件。

## 核查结果

| 能力 | 当前提供方 | 是否需要新增插件 |
| --- | --- | --- |
| 会话、工具、技能发现、批准、文件、图片、基础上下文压缩 | DSH 原生 base/web-app 及原生会话工具 | 否，宿主提供，不复制 Runtime |
| 方案规则、章节技能、材料解析、成果编辑、Word/ZIP 与发布 | 已内置 dsh-ccpg-scheme | 否 |
| 当前用户飞书读取/下载/创建、登录及 CLI 安装 | 已内置 dsh-ccpg-larkauth；官方 lark-cli 通过 profile 安装服务初始化 | 否，必须完成首次账号授权 |
| PDF/Word/Excel/PPT 处理技能 | scheme 内置 PDF 和官方 Office fallback；宿主官方 Office 优先 | 否，不依赖本机全局技能 |
| Office 转换、PDF、图片与 Word 依赖 | scheme 精确依赖及聚合包实体依赖 | 否，依赖组件随包，不新增第二个解析插件 |
| 成果面板与既有文档预览 | 已内置 scheme 客户端、document-preview；既有 sidebar 安装清单 | 否 |
| 外部知识网页读取/检索 | DSH 原生 web 能力，需要用户环境实际可用的搜索渠道 | 否，不能把某个本机浏览器插件定为必需 |
| CCPG 项目数据 | 外部 ccpg-cli，可用时核验取数，缺失时初始化或请求材料 | 不是必需 DSH 插件；不把未核验数据当权威 |

主会话 `session-fa7fad3a-342a-46bc-bfec-9b668793e2a0` 解码 2726 条原生记录，工具调用所在记录包括 compress 41、mnemon_runtime_memory 5、memory_update 2、memory_save 1、modlens_read_image 1、browser_open 1。数字按包含该工具的记录去重，不是模型 token 用量。这里只汇总工具名，不保存原始正文、材料或参数。

这些调用证明本机曾使用额外能力，不证明业务包依赖它们。检查 scheme 的导入、服务依赖声明、技能、安装清单及真实 Cordis/ToolRuntime 测试，未发现它对 mnemon、memory、modlens、billion-context、自动续跑或浏览器社区插件的必需导入/注入。压缩由原生 DSH 管理，方案材料与进度保存在工作目录；不将上述插件加入默认包，也不强制用户移除其自行安装项。

## 必要安装范围

保留 harness-one 已有默认套件及内部 scheme，不为本次业务功能增加新的第三方插件。setup/pack/aggregate 清单已包含 scheme；聚合 package 已声明并实体化 PDF/Office/Word 库。飞书 CLI 是独立工具，通过已有 larkauth 初始化；用户身份登录不能从开发机复制。

原生 Host、标准技能发现、材料及发布集成测试不使用上述社区记忆或压缩插件。全新跨平台 Desktop 端到端模型生成尚未验收，不能用本机多插件环境的运行成功替代干净环境验收。后续若发现必要能力缺口，先定位原生提供方及版本，再决定最少新增项。
