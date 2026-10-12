# 飞书方案目录分层验证

## 范围

D-052：一个方案总目录、可读编号的章节子目录、正文与本章附件同放、完整正文在根目录；跨范围复用附件和原文档地址，保留历史链接。安装不操作真实云空间或业务状态。

修改面：共享发布连接器、原生发布调用方、回执摘要、两端共用页面和旧目录动作、Host/连接器/页面测试、隔离 UI fixture、开发和过程文档。独立浏览器仍只读，不新增发布旁路。

## 定向证据

- `folder-hierarchy.test.mjs` 首次 RED：第二章目录实际为“测试项目 质量方案”，没有章节子目录；实现后 GREEN。
- 受控云空间替身按真实父子关系验证：第二章正文和附件同放；完整正文在总目录；重复发布不写入；全文复用原附件；更新/旧平铺迁移保持正文 token；重新加载保留目录映射；未知章节目录创建不重放；缺失目录成员不能声称成功。
- 原连接器 14/14、原生 Host 16/16、页面状态 43/43 及历史摘要定向回归通过；原生 Host 的云替身现在真实区分总目录、章节目录与两个不同正文 token。

## 构建、页面和安装

- 全仓 `npm test` exit 0；指定 `pack.sh` exit 0，包含规定双构建、scheme 两端构建、聚合装配与固定依赖。打包后包契约、`build-scheme.sh --check`、Host 16/16 及 `git diff --check` 通过。
- 隔离实际浏览器验证原生组件 fixture、380px 窄面板与独立只读页：三个链接分别指向方案总目录、章节目录与原正文；刷新后保留历史，已同步动作禁用，窄面板无横向溢出，控制台无 warn/error。截图保存在 `/tmp/ccpg-folder-hierarchy-ui.png`、`/tmp/ccpg-folder-hierarchy-ui-narrow.png`、`/tmp/ccpg-folder-hierarchy-browser-ui.png`。测试服务器和本轮创建的浏览器页已关闭；未访问假定飞书链接。
- 内部归档：`dist-release/dsh-harness-one-plugins-0.11.4-internal-folder-hierarchy-r14.tar.gz`，239869264 bytes，SHA-256 `aa05d61d4c4e91b51f43e966ce2bcb2490c65c7b7740d3a88ce210b9429a664e`。
- 464 个 scheme 运行资源、1856 次字节比较一致：源码、聚合包、Desktop 安装链接、独立归档与聚合归档；聚合入口/客户端/package/patch 也匹配。最初校验脚本错误要求一个源码不存在的 `licenses/` 目录，修正为实际运行资源后通过；非打包缺陷，不补造目录。
- Desktop 旧进程彻底退出后重启：main 74045，Node Host 74077；2026-10-12 13:08:48（Asia/Shanghai）日志确认 8 个子插件已装配，沿用原 Desktop 安装链接。重启后没有执行页面点击或真实发布。
- 原测试项目 `.ccpg-scheme/state.json` SHA-256 与重启前一致：revision 152、84 份材料、16 份历史成果、0 个准备中的章节。未更换项目规则、重跑生成或写真实云资源；未提交、推送、公开发布或搬迁开发目录。

临时证据：`/tmp/ccpg-folder-hierarchy-full.log`、`/tmp/ccpg-folder-hierarchy-pack.log`、`/tmp/ccpg-folder-hierarchy-postpack-host.log`、`/tmp/ccpg-folder-hierarchy-parity.json`、`/tmp/ccpg-folder-hierarchy-project-baseline.json`。

## 验收边界

本轮未创建、更新、重命名或移动真实飞书文件，未触发模型生成，未更改用户方案业务状态。移动需要当前用户对原件及源/目标目录有相应权限；远端已改变位置或正文/附件内容时停止。断网后未知写入仍需核对，不能自动重新创建。
