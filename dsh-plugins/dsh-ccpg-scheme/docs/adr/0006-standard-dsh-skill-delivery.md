# ADR-0006：章节技能使用 DSH 标准发现格式

## 状态

Accepted：2026-10-10 用户明确要求章节技能必须能被 DSH 原生智能体运行，不接受自创格式。目标 Desktop 组合仍需安装验收。

## 背景

章节技能携带业务规则以及知识、模板、参考案例等资源。如果只生成编译器私有文件或自定义清单，DSH 原生 Agent 无法通过标准技能目录发现和加载它们。

## 决策

1. 每个章节生成标准目录 bundle：`.dsh/skills/<kebab-name>/SKILL.md`。`SKILL.md` 以 YAML frontmatter 开始，必填 `name` 和 `description`；目录名与 `name` 保持一致，正文使用 Markdown，资源放在同一技能目录的 `references/` 或 `assets/` 下。
2. 专用方案工作目录初始化 `.git`，因此 DSH 官方 `dsh-skill-filesystem` 会把 `<projectRoot>/.dsh/skills` 作为 rank 100 的项目技能根扫描。章节执行提示可显式加载该技能，原生模型也可通过标准 skill 工具发现。
3. PDF/Office 等默认解析技能继续由插件通过 `ctx.skills.registerProvider()` 提供；项目章节技能不重复注册 provider，避免同名和项目隔离问题。D-037 明确 Office 直接使用随包官方原文、脚本和资源，rank 601 作后备，宿主 rank 600 官方技能优先；不能用自定义同名包装覆盖宿主或依赖相同 rank 的注册顺序。
4. manifest 只做完整性、依赖、hash 和 blocker 校验，不替代 DSH 技能发现协议。资源链接使用相对于 `SKILL.md` 的路径，`resourceBase` 由原生文件系统提供方指向技能目录。

## 证据

本机 DSH `@deepseek-ai/dsh-skill-filesystem` 0.2.0-rc.2 文档和源码确认：项目根取最近 `.git` 祖先，扫描 `.dsh/skills` 顶层目录 bundle，格式为必填 `name`、`description` 的 frontmatter。真实 Cordis 测试已验证项目章节技能以 `project-dsh` 来源被发现和加载。

2026-10-10 修复验证：真实 SkillRegistry 同时挂载宿主 `dsh-skill-office` 和插件 provider，实际加载宿主官方 Office，插件后备的 resourceBase 指向包内官方 assets；Skills 3/3 通过。

## 结果

章节技能可以随专用方案目录被原生 Agent 使用，资源随技能目录一起复制并接受 hash 校验。私有候选未获得分发授权前不覆盖插件默认包；目标 Desktop 的干净安装和真实模型执行仍需单独验收。
