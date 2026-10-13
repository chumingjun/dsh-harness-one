# 飞书原文档复用与历史地址

2026-10-12，分支 `codex/ccpg-scheme-tdd`；不提交、不推送、不公共发布，本轮不执行真实云写。

## 修改及根因

页面原链接仅存组件内存；Host 操作 ID 包含全局 revision 和交付快照版本，使同章可能重复创建。现在范围固定为章节 ID 或全文，交付文件摘要判断内容变化；既有回执与不可变交付清单恢复历史，读取不修改旧回执及业务 state。

成果页显示正文、方案文件夹和发布历史；已同步禁用重复按钮，保存新成果后显示更新原文档。两端共享摘要与展示。明确人类更新点击授权本范围目标，Agent 更新仍保留原生批准。当前用户 `lark-cli --as user`、快照/CAS、取消、写前 intent、图片/附件及目录成员回读保持。

正文与图文附件通过 `docs +update --command block_replace --start-block-id 0 --end-block-id -1 --revision-id …` 更新，二进制原件使用 `drive +upload --file-token …`。先读回核对基准版本/内容或附件 hash；冲突、未知写入和附件类型/身份不明不创建副本绕过。旧云文件不自动删除。

## 验证

- RED/GREEN：新范围复用测试首先稳定复现 `reused` 缺失，UI 新状态测试先失败；修复后 connectors 14/14、client 43/43、历史回执自检通过。
- 原生 Host 16/16，包含 Remote 恢复历史地址、不发送远端全文、其他章节完成后复用本章、Agent 更新保留批准。全文改附件后保持原文档，内容回退覆盖旧版本而非复用过时操作。
- 图片正文与图文附件更新保持原 token，固定 revision 和本地图片引用；写后核验原图位置/字节。二进制附件同 token 覆盖，远端编辑阻止本地覆盖。
- 真实原方案只读恢复第二章原正文 `WnGadVDk1oCOdmxpmfvcUP8Pn5d` 和目录 `DNGKfTpFwl2s1gd6YoncqahRn7g`；不需要重新创建。
- 隔离真实浏览器：刷新后原正文、目录和 2 次历史仍可见，已同步按钮禁用，控制台无 error/warn。受控 fixture 不调用模型或云服务；不冒充真实云更新验收。

## 安装收尾

- 最新完整 `npm test` exit 0；规定 `pack.sh`、包契约、`build-scheme.sh --check` 和 `git diff --check` 通过。打包后原生 Host 16/16、connectors 14/14、历史回执自检再次通过。既有 bundle 体积和 Node 实验性警告不作为新增故障。
- 内部归档 `dist-release/dsh-harness-one-plugins-0.11.4-internal-publication-reuse-r13.tar.gz`，239865118 字节，SHA-256 `3802e8b36ac2c39074c515e71707c396ea4d2cf69807a6b9503353cbb019a55c`。
- 源码、聚合包、Desktop link、独立归档和聚合归档共 465 运行文件、1860 次字节比较一致；聚合入口/前端/挂载 patch 一致。首次验证错误地要求聚合子包保留独立 `cordis.patch.yml` 和 LICENSE，按现有装配边界修正核查范围后通过；未改安装结构。
- 12:09:05 宿主日志确认 8 子插件及固定当前用户飞书 CLI。Desktop main PID 58755、Node utility PID 58787；旧 main/Host 已彻底结束后重新启动。重启前 UI 空闲且日志无新生成活动，重启时 Mac 已锁屏，未完成重启后真实面板目测。
- 原方案 1493 文件无新增/丢失；只两份 DSH 自身 `.workflow-one` SQLite shm/wal 改变。业务仍 revision 152、84 材料、16 历史成果，固定 r6；默认安装规则 r9。已安装代码只读恢复第二章原链接，原正文、材料及发布回执 hash 保持。

![隔离成果页刷新后保留链接与发布历史](/tmp/ccpg-publication-reuse-ui.png)

## 未验收

没有真实覆盖用户云文档，CLI 全范围替换及评论保留需实际云验收；本地和远端同时编辑会停止，未实现双向合并。二进制云接口无 revision CAS，更新前核对字节但不能消除两次请求之间的远端并发修改。未知写入需运维核对，不自动重建。跨平台全新安装未验收。
