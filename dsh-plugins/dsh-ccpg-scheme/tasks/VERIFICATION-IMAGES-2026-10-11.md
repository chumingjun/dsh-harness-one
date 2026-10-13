# 图片原件与图文交付验证

日期：2026-10-11，Asia/Shanghai。分支：`codex/ccpg-scheme-tdd`。

## 实现范围

- 图片和二进制附件通过 `filePath` 保存原件，不要求模型输出 Base64。
- 正文及 Markdown 附件在标准行内图片引用处保存、显示原图；不以文字替代图片。限制在项目目录内，拒绝软链、越界、秘密路径、远程图片和不匹配的图片格式。
- 图片快照纳入成果文件 hash；预览、编辑、保存和导出复用快照。原始材料移走后仍可保存；中文引用被编辑器 URL 编码后仍可匹配。
- 图文章节下载 ZIP，包含 Markdown 与图片；图片附件下载原件。全文 ZIP 合并正文并保留独立附件和图片，引用路径可携带。
- 飞书转换使用当前用户 CLI 的本地图片引用；正文、图文附件文档及二进制原件位于同一云文件夹。回读图片位置、下载图片校验 SHA-256；失败不报告成功。
- 默认标准技能、运行 AGENTS 与编译器同步为 `source-8073-internal-r8`。15 章、417 资源、零 blocker；输入输出和依赖接口、资源清单/hash 与 r7 一致。

## 已执行验证

- 核心公开提交/编辑/导出、CLI 连接器和真实编辑器边界的聚焦测试：56/56 通过。
- 中文路径回归先失败（原图移走后 ENOENT），修复快照复用后通过。
- 隔离原生客户端 harness 中，15 项编辑自检全部通过；正文、图片附件、图文附件和全文预览图片加载成功，无外部图片请求。
- 实际点击下载检查章节 ZIP、图文附件 ZIP、图片原件和全文 ZIP 的文件、路径及原始 PNG 字节。
- 实际编辑、保存、重载后成果版本 2，正文修改和图片均保留。
- 收尾修正仅涉及测试 harness：模拟全文导出现在复用 `mapDocumentImages`，匹配编辑器编码后的中文路径。重跑实际编辑/保存/重载与四种下载，全部图片原件字节相同；全文正文指向 `图片/园林图.png`，图文附件指向 `../图片/园林图.png`，不再引用输入目录。生产导出逻辑未因此修改。
- 收尾再次运行全仓 `npm test`（exit 0）、聚焦 56/56、Host/Skills 18/18（Host 15，Skills 3）、scheme 构建漂移检查及聚合包契约（593 文件，4 个 client factories），均通过。日志：`/tmp/ccpg-images-closeout-tests.log`、`/tmp/ccpg-images-closeout-host.log`。浏览器无 warning/error；截图 `/tmp/ccpg-images-closeout.png`。
- 本轮截图容器宽度 1280px，`.scheme-shell` 的 clientWidth/scrollWidth 均为 1280；未重跑所有响应式宽度。

测试图片为有效 1x1 PNG：只证明图片显示链路、位置和字节保存，不代表真实业务图的可读性或模型语义验收。harness 与用户 Desktop、真实模型、云写隔离。

## 打包与安装

内部归档已完成：`dist-release/dsh-harness-one-plugins-0.11.4-internal-images-r8.tar.gz`，233332456 bytes，SHA-256 `51fbf3fe31160e4534bb61ad27f44bf5ddf457ddc8ec1807689e866ad6e325ce`。

Desktop 当前链接 `~/.dsh/profiles/desktop/node_modules/dsh-harness-one` 解析到本仓库 `dsh-plugins/dsh-harness-one`，磁盘默认规则为 r8。收尾重新核对 462 个运行文件，源码与安装目录、独立归档、聚合归档共 1386 次字节比较通过；聚合入口/client/patch/package 4 文件及独立插件 LICENSE 另行一致。归档不含本插件 test/tasks/authoring/local-data 或用户运行目录。检查器最初错误地假设不存在的可选 licenses 目录和聚合子插件 LICENSE；按装配脚本修正检查对象后全部通过，未改安装布局。

本次修正的是归档排除的测试 harness 和过程文档，运行文件与既有 r8 归档一致，无需重复打包。未重启 Desktop，未迁移已有用户项目；运行中的 Host 可能仍缓存旧模块，正常完整退出并重新打开后才能确保加载新版。

## 验收边界

真实模型生成、最新 Desktop 界面、当前用户飞书图文转换/回读、跨平台干净安装待验收。Word 转换未实现。图片支持 PNG/JPEG/GIF/WebP，每份成果图片总量最多 25 MiB。

没有提交、推送、公共发布、真实云写、访问示例链接或修改旧平台。旧成果只有文字描述时，必须有真实原件才能补入图片。
