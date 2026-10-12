# 2026-10-11 第四章中断修复与 r6 内部部署记录

## 故障链路

只读核对真实方案 `/Users/linbiqiu/trae/项目质量方案测试` 与 DSH Host 日志：修复前 revision 67、规则 r2、46 份材料、3 份成果；第 1-3 章 submitted，第 4 章 prepared。中断不是单一模型失败，而是四个机制问题叠加：

1. 第 4 章随包知识 Z-1 至 Z-8 已在技能目录内，但 `chapter_prepare` 没有自动登记绑定，模型反复收到 `required input missing: Z-*`。
2. 原生工具 schema 未明确附件必填字段，模型把 `outputId` 写成 `id` 或只给 `contentPath`，多次提交被拒。
3. 第 4 章未提交时模型提前读取第 5 章 Z-9 至 Z-12，两张图片被外部图片工具处理并在同一会话累积；该工具一次 180 秒超时。
4. 后续请求约 416537 tokens，超过 `glm-5.3-flash` 253686 窗口，其中图片约 274501 tokens，触发 `preflight_compress_failed`。同时 billion-context 拒绝 DSH 原生压缩调用，Host 多次记录 403；本插件不依赖该压缩插件，也未修改其配置。

## 修复

- `chapter_prepare` 自动登记并绑定当前章声明的内置知识原件；同 hash、同解析版本的完成材料直接复用，未完成知识给出材料 ID、原件和解析路径。
- 原生 `chapter_submit` schema 明确附件契约：`outputId`、`name`，以及 `content`、`contentPath`、`base64` 三选一；`contentPath` 只接受项目 notes 下安全 UTF-8 文本并做提交快照。
- `material_parse` 禁止在当前未完成章提交前读取后续章内置知识，防止模型提前加载下一章图片。
- 删除自定义图片卸载逻辑，改用 DSH 原生 `dsh-compaction-image-offload`；专项测试用真实 PiAiAdapter、Session、AttachmentStore 和原生 image-offload，证明超预算请求不转发上游、同会话记录 `image/offload` 后重试，原件不变。
- 默认规则升级为 `source-8073-internal-r6`，417 份资源 hash 不变；15 个标准技能说明当前章优先、附件契约、自动绑定知识和错误恢复边界。第 7 章继续显式标注“内部测试补充定义”。
- 规则版本快照改为按 `<version>/<chapterId>/SKILL.md` 保存。同一版本可逐章替换未完成技能；失败清理本次章节快照，不删除其他章节快照。

按用户要求，本插件不与 billion-context 或其他压缩插件强绑定。Desktop `einwin` provider 仅启用 DSH 原生图片预算：每张 1572864 pixels / 98304 bytes 目标，单请求累计 base64 图片 196608 bytes。`--dump-config` 已核实三项生效；该策略减少超大图片进入请求，不改变原始附件，也不宣称上游 token 计算完全等同本地字节数。

## 验证

- 新增/更新聚焦回归后，两次全仓 `npm test` 均退出码 0；最后一次覆盖 core、Host、材料路由、native image budget、编译器、Skills、客户端与既有插件。
- `sh dsh-plugins/build-web.sh` 完成规定双构建；`sh dsh-plugins/build-scheme.sh --check` 通过。
- `sh dsh-plugins/pack.sh 0.11.4-internal-chapter-r6` 完成 8 子插件内部装配、依赖实体化、QuickJS smoke 与包契约检查；`scripts/verify-plugin-packages.mjs` 通过，聚合 client 4 个工厂注册正确。
- 当前归档字节稳定为 233269009 bytes，SHA-256 `f1173f09b90889d56a401e4a078c4be8b83402ebc242c53d9a8a5458814c38a3`。归档、源码和 Desktop 链接聚合目录的 11867 个第一方运行文件逐字一致（不把安装期生成的 node_modules 元数据当第一方契约）。
- `git diff --check` 通过。

## 用户项目迁移

在 Host 空闲且第 4 章仅有过期 prepared token 时执行受控迁移：先恢复项目，再逐章替换第 4-11 章未完成技能。revision 67 -> 80，manifest 版本 r2 -> r6。

迁移后核对：

- 46 份材料、3 份成果、前 3 章 submitted 状态保持。
- 18 个成果文件 SHA-256 全部与 state 记录一致。
- 第 4 章为 `interrupted`，8 个绑定保留；`chapter-4-body.md` 与附件草稿仍在 `materials/notes/`。
- 第 4-11 章 12 个技能快照存在，第 4 章和第 11 章活动技能与 r6 源包 hash 一致。
- 已提交第 1-3 章未替换，避免无谓置 stale；项目 `AGENTS.md` 保持用户 r2 原文，不因全量指令更新破坏既有成果。

## 部署与边界

Desktop `desktop` profile 的 `dsh-harness-one` 依赖继续链接到当前仓库聚合目录，内部包已部署到源码聚合；重启前 Host 进程仍加载旧模块。用户完整重启 DSH Desktop 后才会加载 r6 与原生图片预算配置。

未做：真实模型第四章续跑质量验收、图片缩放后的业务可读性人工确认、飞书正式发布、公共发布、commit/push、云端诊断上报。billion-context 与 DSH 原生压缩的宿主级共存策略仍属 Desktop 配置问题，不由业务插件接管。
