# 参与贡献 / Contributing

感谢你改进 Workflow One。提交前请先搜索现有 Issue；使用问题和工作流配置交流优先放到 [Discussions](https://github.com/chumingjun/dsh-harness-one/discussions)。

## 开发环境

- Node.js >= 22.15.0
- 全局安装 `@deepseek-ai/dsh`
- macOS / Linux，Windows 使用 WSL 或 Git Bash

```sh
npm install
cd web && npm install && cd ..
npm test
sh dsh-plugins/build-web.sh
```

改动插件源码后必须彻底重启 dsh，避免模块缓存继续使用旧代码。任何 API Key 都只能通过环境变量或 dsh 凭据配置注入，不得写入仓库、测试夹具或日志。

## 提交流程

1. 从最新 `main` 创建短命主题分支：`feat/`、`fix/`、`refactor/`、`docs/`。
2. 只修改与目标相关的文件，并为非平凡逻辑补最小回归测试。
3. 使用 Conventional Commits，例如 `fix(orchestrator): 修复运行恢复状态`。
4. 提交 PR，说明背景、方案和验证结果；前端改动附截图。

新增节点类型时必须同步引擎注册表、前端注册表、AI 助手节点契约和变量树。构建产物不提交到仓库。

## Pull Request 检查

- `npm test`
- `sh dsh-plugins/build-web.sh`
- `node scripts/verify-plugin-packages.mjs`
- 没有凭据、个人数据或工作区 `.workflow-one/` 文件
- 文档与用户可见行为同步更新

English contributions are welcome. Keep pull requests focused, describe observable behavior, and include the commands used to verify the change.
