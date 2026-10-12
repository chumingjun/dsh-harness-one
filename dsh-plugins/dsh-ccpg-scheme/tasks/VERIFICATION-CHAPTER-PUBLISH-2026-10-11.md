# 章节发布与 PDF worker 验证

日期：2026-10-11，Asia/Shanghai。分支：`codex/ccpg-scheme-tdd`。

## 修改及原因

- 共享 `loadPdfjs` 用 `import.meta.resolve` 显式定位包内 worker。PDF.js 把 Electron utility 排除出 Node 环境，跳过默认路径；没有增加另一套解析流程。纯文字不渲染图片的原路由保持。
- 整章正文不再在目录中重复显示成缺失小节，实际缺失输出仍保留。
- 每章正文表头可独立转飞书。复用原云发布后端，新增可选章节范围及该章快照路径；原生批准、当前用户身份、草稿/确认/版本/完整性校验、取消及回读保持。
- UI 测试 fixture 补齐真实 state 的 `confirmed` 字段；切章清除上章操作状态和错误，防止串章提示。

## 验证证据

| 验证 | 结果与边界 |
| --- | --- |
| 全仓 `npm test` | 退出码 0，日志 `/tmp/ccpg-scheme-chapter-publish-tests-20261011.log` |
| 聚焦回归 | materials 28/28、client 38/38、core 44/44、Host 15/15 |
| worker 故障与修复 | 模拟 Electron utility 身份，未配置时重现同一报错；配置包内路径后成功初始化。日志 `/tmp/ccpg-pdf-worker-red-green-20261011.log` |
| Desktop 可执行文件 | Electron Node 模式下 materials 28/28，含 utility 身份模拟；日志 `/tmp/ccpg-pdf-electron-worker-20261011.log`。不等同真实 Host 内模型续跑 |
| 隔离真实浏览器 | 未确认禁止转换；确认本章后后续章未确认仍可转换；只展示 verified 模拟云链接；切章不残留上章状态/链接；无虚假整章“待生成”节点；正文图片 640×360 已加载 |
| 构建与契约 | `pack.sh` 双构建及内部装配成功，`build-scheme.sh --check`、包契约和 `git diff --check` 通过 |

页面截图：`/tmp/ccpg-chapter-publish-final-20261011.png`。页面使用内存测试方案与模拟 CLI，没有真实云写或模型调用。

## 安装与数据保护

内部归档：`dist-release/dsh-harness-one-plugins-0.11.4-internal-chapter-publish-r8.tar.gz`。

Desktop profile 链接使用仓库聚合目录。源码、聚合安装、Desktop 链接及独立/聚合归档共 451 个运行文件完成 1804 次字节比较，无差异；包内 PDF worker 与 Darwin arm64 canvas 二进制存在。归档大小 233346134 字节，SHA-256 `fc984a4c7847985853f9e1980c6bfa075697fc41df415e80e989124517fceef4`。校验日志 `/tmp/ccpg-chapter-install-parity-20261011.log`。

2026-10-11 22:55（Asia/Shanghai）确认原会话空闲后完整退出 Desktop，旧 main 39994 / Host 40021 已消失，再启动得到 main 71697 / Host 71732。22:55:32.545 Host 日志确认 8 个子插件装配，71732 监听 `127.0.0.1:43120`；重启后成果面板加载，章节表头可见“转为飞书云文档”。重启后再次运行 materials 回归 28/28，通过 utility 身份模拟和受限 builtin-module 分支；仍不等同实际 Host 模型续跑完成。

安装前原测试项目只读核对：state SHA-256 `7170f2a8850d07c342cbe9657012ba4eafdf4786861906536ec6b25cff4b00c8`，revision 144、80 份材料、14 份成果、没有 prepared 章节。不迁移固定规则，不改材料和成果，不替用户确认或发送生成指令。

重启后只读核对同一 state，SHA-256、revision、材料及成果数不变。22:56 界面显示用户自行发送“请你继续执行”，原生会话已恢复运行；本次代理不发送消息、不停止该运行，也不更换其固定规则。已有 provider 压缩 403 警告仍显示 `continuing the turn`，不属于 PDF worker 初始化错误，本轮未修改 provider 配置。

## 未验证项

- 真实 Desktop utility 的第 11 章模型续跑及当前用户飞书云写需用户继续验收。
- 未修改 Runtime、provider、凭据或原项目；Word 转换、自动问题评估报告和跨平台干净安装不属于本次已完成范围。
- 旧字体/cMap 警告未通过增加解析流程掩盖；材料语义是否完整仍以真实核对为准。

无提交、推送、公共发布或真实云写。
