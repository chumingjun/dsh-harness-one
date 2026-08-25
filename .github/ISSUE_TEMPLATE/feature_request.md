name: 💡 功能建议
description: 新节点类型、交互改进、集成想法
labels: [enhancement]
body:
  - type: textarea
    id: problem
    attributes:
      label: 你想解决什么问题
      description: 遇到的场景/痛点，而不是想要的方案——先讲问题更容易找到对的解法
    validations:
      required: true
  - type: textarea
    id: idea
    attributes:
      label: 你的设想
      description: 期望的交互或行为；如果只是模糊的想法，写个大概也行
    validations:
      required: false
  - type: dropdown
    id: area
    attributes:
      label: 涉及部分
      multiple: true
      options:
        - 画布 / 节点
        - 运行引擎（调度、续跑、审批）
        - 官方 UI 集成（侧栏、对话区）
        - 飞书集成
        - 安装 / 发版
        - 其他
    validations:
      required: false
