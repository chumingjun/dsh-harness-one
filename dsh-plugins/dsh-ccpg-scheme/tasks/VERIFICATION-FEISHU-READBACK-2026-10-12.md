# 飞书转换回读误判修复

日期：2026-10-12（Asia/Shanghai）。分支 `codex/ccpg-scheme-tdd`；无提交、推送或公共发布。

## 根因与范围

用户点击第二章“转为飞书云文档”后，文件夹及正文已创建，随后回读校验返回 uncertain。当前 Desktop profile 的官方 CLI 以 `--as user` 读取已创建正文，revision 3；正文内容保持，表格分隔线由 `| --- |` 转为 `|-|`，`V\[年\]` 转为 `V[年]`。旧连接器按 Markdown 字节比较，误判正常规范化。

修改仅在共享连接器和对应回归测试：复用已安装的 markdown-it 比较解析后文档表示，覆盖旧单文档发布、章节和全文交付。标题层级、单元格顺序、数值、链接目标、正文、图片位置及图片字节仍校验。没有新增模型循环、认证客户端或依赖。

所有远端写入都有 confirmed target 的 uncertain 交付，重试只复用已记录目标并重新核对；有未确认写入或缺步骤则保持 uncertain。创建意图后进程退出、没有最终回执时，也禁止重放该写入。

## 验证

- 两项新增回归先 RED 后 GREEN；创建意图后崩溃回归另行 RED/GREEN。
- 连接器 11/11 通过，覆盖正常规范化、真实文字/表格/标题/链接差异、未知创建结果、取消、附件字节和图片位置/字节。
- 使用固定 Desktop CLI 对原第二章执行真实验证，仅允许 `docs +fetch` 与 `drive files list`。本地固定快照、远端全文及所在文件夹通过，零云写。成功回执追加到原 publication NDJSON，项目 state 字节保持。
- 全仓测试和内部安装的最终证据在下方收口；未把只读核验描述为重新创建成功。

## 安装收口

- 最终全仓 `npm test` 退出 0。`pack.sh` 退出 0，包含规定双 base 构建、scheme 构建、内部装配、依赖实体化及归档 smoke。打包后 Host 16/16、包契约和 scheme bundle 漂移校验通过；`git diff --check` 通过。
- 归档：`dist-release/dsh-harness-one-plugins-0.11.4-internal-feishu-readback-r11.tar.gz`，239841835 bytes，SHA-256 `821b83d7fe45cb9e299aa2b193baf37a796654e87b0bc91a41ff2ee5d6ef0f92`。
- 464 个运行文件、1856 次字节比较在源码、聚合、Desktop 链接与两个 staging 位置一致。归档两个连接器位置单独逐字核对，含 markdown-it/docx/pdfjs-dist；未包含 scheme tasks/authoring/test/用户状态。默认规则保持 r9，既有项目固定 r6。
- 已确认空闲后 TERM 主进程并完整重启。新 main PID 14321，Host PID 14368；10:24:09 lifecycle renderer healthy，宿主记录 8 子插件装配。实际成果面板重新显示当前方案。
- 基线 1493 文件核对：除原生 `.workflow-one` 三个 SQLite 文件随进程退出/重启变化外，其余字节保持；方案 revision 152、84 材料、16 历史成果不变。本轮成功回执在基线前追加，单独核对 state 未改。
- 桌面点击验证两次因用户操作改变现场被工具拒绝，恢复现场后停止抢占；未点击发布按钮，不宣称按钮链路实测成功。真实当前用户只读回读已验证，原生发布 Host 测试通过。用户可重新点击第二章按钮复用成功回执。

## 边界

本次真实验证仅覆盖第二章文字与表格，没有真实图片/二进制附件云端上传；这些保留回归测试证据。云端与本地存在实际内容差异时仍应拒绝核验成功，结果未知的写入仍需只读调查，不自动重新创建或覆盖。
