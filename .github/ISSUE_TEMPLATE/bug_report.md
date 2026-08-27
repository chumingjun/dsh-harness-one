name: 🐛 Bug 报告
description: 安装失败、运行报错、界面异常
labels: [bug]
body:
  - type: markdown
    attributes:
      value: |
        感谢反馈！请先确认：
        - 用的是 npm 安装（`dsh plugin add dsh-ccpg-one`）还是源码安装（`setup.sh`）
        - 已在 [Releases](https://github.com/chumingjun/dsh-harness-one/releases) 确认不是已修复的旧版问题
  - type: input
    id: version
    attributes:
      label: 版本
      description: `dsh plugin list` 或 package.json 里的版本号（如 dsh-ccpg-one@0.2.1）
    validations:
      required: true
  - type: dropdown
    id: env
    attributes:
      label: 运行环境
      options:
        - 普通 dsh（命令行 / Web UI）
        - Harness Desktop
        - 两者都有
    validations:
      required: true
  - type: textarea
    id: what-happened
    attributes:
      label: 发生了什么
      description: 预期行为 vs 实际行为；报错请贴完整日志（boot 失败看终端输出，运行失败看节点详情里的错误）
      placeholder: |
        预期：…
        实际：…
        报错日志：
        ```
        ```
    validations:
      required: true
  - type: textarea
    id: repro
    attributes:
      label: 复现步骤
      placeholder: |
        1. …
        2. …
    validations:
      required: false
  - type: textarea
    id: context
    attributes:
      label: 补充信息
      description: 工作流截图、节点配置（可脱敏）、Node 版本、操作系统
    validations:
      required: false
