# 材料解析修复

日期：2026-10-10。分支：codex/ccpg-scheme-tdd。范围仅当前 DSH 插件材料链路，不改旧平台或 DSH Runtime。

## 根因

1. PDF 提取文字后仍无条件返回 needs-vision；视觉批次按所有物理页遍历。
2. 核心材料校验要求所有 PDF 都有视觉回执，文字 PDF 即使改状态也无法绑定。
3. 运行 Skill 强制逐页手工选择图片工具，已完成的视觉材料再次 parse 返回初始不完整版本。
4. 退出钩子把“访问同一项目”误当作“拥有主章节”，子智能体结束可能撤销主章节。
5. 字体缺口处理 push 修改原生冻结 unresolved，真实工具管线会抛不可扩展对象错误。
6. 重启后成果面板直接访问浏览器认证 HTTP 路由，Desktop 原生连接没有这份 Cookie；首读错误又被“读取方案成果”遮盖。修正通道后又复现冷会话不在活动 Session Map，须从原生持久元数据读取 cwd。

## 最小完整改动

- [x] 真实 PDF/DOCX fixture 复现，纯文字、同页图文、混合扫描、矢量与批注分类。
- [x] PDF 记录 visualPages，纯文字直接 complete；绑定门禁区分不需要视觉和已完成视觉。
- [x] 下一项仅选择视觉缺口，完成计数匹配；解析版本 3 重新分类旧缓存并保留部分进度。
- [x] 薄 material_visual_read 经原生 nested dispatch 传图，不复制模型循环；主会话拒绝接图，一子会话一项。
- [x] 成功回执、权限、能力、取消、同会话与 hash 校验保留；完成后复用完整 Markdown。
- [x] 子会话退出按 token.sessionId 处理，缺失字体用本地副本保存。
- [x] 标准解析/方案 Skills、编译器、运行 AGENTS、r3、开发规则与复盘同步。
- [x] 原生面板读取复用官方 Typert Remote/Connection，读取不追加命令或修改 state；初始化错误可见，连接恢复重新读取。
- [x] 全仓回归、规定构建、内部归档、Desktop 链接目录一致性。
- [x] 当前 Desktop 完整重启，实际加载业务目录、知识依赖与已生成正文。
- [ ] 用户真实多模态材料语义、第 3 章绑定与完整方案生成验收。

## 证据与边界

RED 已分别复现 PDF 分类、输入门禁、视觉批次计数/旧记录、原生传图入口缺失、图块累计、冻结参数及子会话退出缺陷。真实 DSH ToolRuntime/FileSystem/AttachmentStore 集成已验证图块输出，不调用真实模型、不访问云材料。

当前 SDK 0.2.0-rc.2 普通文件附件投影为路径提示，不能声称 Word/PDF 原件已进入模型。图片和扫描内容由配置的多模态模型解读；文本提取与页渲染只负责格式和传输。unsupported Office parts、模糊数字和缺失字体不猜补、不提前放行。

不强制改用户方案目录、规则或成果。既有图片已经进入历史会话的超窗请求不能靠插件逆向删图；用户已选择新会话，继续从落盘进度恢复。

## 最终验证与安装

- 最新全仓 `npm test` exit 0；打包后 Host 13/13、原生材料路由 6/6，零失败、零跳过。冷会话读取已通过真实 Typert Gateway 和宿主专项。
- `pack.sh 0.11.4-internal` exit 0，包含规定双构建、聚合装配和实体依赖；`build-scheme.sh --check`、包契约和 `git diff --check` 通过。
- 源码、Desktop 链接目录、归档单插件及归档聚合插件的 462 个运行文件逐字一致；聚合 client 和 patch 同样一致。归档 233224261 bytes，SHA-256 `0aedc2f926f9f73f799179f3a2c0cadcdbad10a9ea6ee2b9ead099c94d0954f8`。
- 北京时间 20:53:52 正常重启完成，Desktop Beta 2.0.17-beta.1 renderer healthy，Host 日志确认 8 个子插件装配。真实面板无需先发消息即可加载旧会话项目，第 4 章仅两个项目输入、八个知识依赖，目录包含 8.1–8.5；第 1 章已提交正文与版本实际可见。
- 原测试项目仍为 revision 35、27 份材料、第 1/2 章 submitted，其余 pending；未迁移 r2 规则、未覆盖正文或发送生成指令。
- 原始日志见仓库 `.superpowers/sdd/IMPLEMENTATION-PLAN/` 下 `tests-material-routing-final-20261010.log`、`pack-material-routing-final-20261010.log`、`host-material-routing-final-20261010.log` 和 `native-material-routing-final-20261010.log`。
