name: Pull request
description: 提交代码改动
labels: enhancement
body:
  - type: markdown
    attributes:
      value: |
        提交前请确认：构建 0 错、`node tests/run-offline.mjs` 全绿。

  - type: textarea
    id: what
    attributes:
      label: 改动内容
    validations:
      required: true

  - type: textarea
    id: why
    attributes:
      label: 改动原因
    validations:
      required: true

  - type: checkboxes
    id: checklist
    attributes:
      label: 检查项
      options:
        - label: `node scripts/build.mjs` 通过
          required: true
        - label: `node tests/run-offline.mjs` 通过
          required: true
        - label: 未提交任何凭证、本机路径或构建产物（`lib/`、`*.tgz`）
          required: true
        - label: 保持关闭态零副作用；重模块仅经 `src/lazy/load.ts` 懒加载
          required: false
        - label: 日志前缀统一 `freetoken:`
          required: false