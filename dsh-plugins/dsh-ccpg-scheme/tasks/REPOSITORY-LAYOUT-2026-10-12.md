# 开发目录与统一安装建议

状态：Proposed。2026-10-12 本地只读核查；未迁移、删除目录，未连接远程服务器，未提交或推送。

## 当前事实

实际插件源码位于 `dsh-harness-one/dsh-plugins/dsh-ccpg-scheme/`，包含运行库、前端、测试、规则编译源、标准技能及过程文档。setup/build/pack/assemble 从这里读取。

同级 `new-api-test/dsh-ccpg-scheme/` 不是 Git 仓库，只有早期规划、章节编译及测试，没有完整运行代码；部分文档已经过时。不能把它当作当前版本。

`dsh-harness-one/dsh-plugins/dsh-harness-one/` 是生成的安装包目录，Desktop 当前 link 指向这里。它不是第二份开发源码，不在这里手改。

当前源码处于 `codex/ccpg-scheme-tdd`，方案插件尚未提交。独立分支不能代替文件进入版本历史；用户未授权提交、推送或公开分发内部资源。

## 推荐布局

统一仓库、独立插件包、统一构建安装，保留当前实际源码位置：

```text
dsh-harness-one/
  dsh-plugins/
    dsh-ccpg-scheme/     # 业务源码、技能、资源、测试和过程文档
    dsh-ccpg-larkauth/   # 当前用户飞书 CLI 接入
    其他现有插件/
    setup.sh / pack.sh / assemble-one.sh
    dsh-harness-one/     # 生成的内部安装包，不手改
  .superpowers/         # 集成任务进度
```

这满足“安装是一体、代码不混淆”，不用为了目录名称再复制一套源码。后续获准整理时，先核对同级旧目录中的独有历史（包括 plan/todo 和旧编译测试），将仍有价值的内容整合到当前插件，确认没有外部引用后再退役旧目录；本次只提供建议。

只有确实需要独立访问权限或独立发布周期，才将同级目录建立为独立业务 Git 仓库。届时由集成构建读取明确版本的业务包，统一装配；不能用人工双份复制或开发机绝对路径作为远程依赖。当前不推荐拆成两仓。

## 远程存放建议

Git 远程仓库与运行服务器是两件事；当前只核实本地 Git remote，没有服务器配置证据。

若需要内部构建服务器，可采用：

```text
/srv/ccpg/src/dsh-harness-one/             # 源码，业务包仍在 dsh-plugins 内
/srv/ccpg/releases/harness-one/<版本>/    # 通过 pack.sh 生成的内部安装归档
```

用户方案、输入材料、成果、会话和账号凭据继续留在各自 Desktop 工作目录及用户 profile，不进入源码或统一安装包。首版不增加服务器运行服务。

业务知识资源与内部技能不得上传上游公共仓库或公共 npm。是否存入私有远程仓库及权限范围必须另有明确授权。
