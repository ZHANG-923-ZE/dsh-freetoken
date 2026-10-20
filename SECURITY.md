# Security Policy

## 关于本项目的风险面（请先读）

本插件**驱动 chat.deepseek.com 的私有网页接口**。这意味着：

- 它触碰的是第三方服务的非公开接口，可能随时变更或失效；
- 使用方式可能违反上游服务条款，导致限流甚至账号封禁；
- 插件会以你的本机权限运行浏览器进程与本地文件读写。

**请只使用可丢弃的测试账号，不要在主账号上启用。**

## 凭证处理

- 登录凭证（token / cookie / 反爬指纹头）只写入 `<DSH_HOME>/freetoken/`（默认
  `~/.dsh/freetoken/`），权限由本机用户目录保护。
- 日志只输出掩码后的凭证。
- 凭证**绝不**进入仓库、提示词或日志文件。
- 撤销授权：在 DSH 中执行 `/freetoken logout`，或直接删除 `~/.dsh/freetoken/auth.json`。

## 报告漏洞

**请不要用公开 issue 报告安全问题。** 请通过 GitHub 仓库的
[Security Advisories](https://github.com/ZHANG-923-ZE/dsh-freetoken/security/advisories/new)
私下报告，或直接联系维护者。

报告内容请包含：

1. 问题类型与影响范围；
2. 复现步骤；
3. 受影响的版本 / commit；
4. 你的环境（DSH 版本、Node 版本、操作系统）。

我们会在确认后协调披露。涉及凭证泄露的报告，请先自行撤销/轮换相关凭证。

## 责任边界

本项目与 DeepSeek 无任何关联，不提供官方支持，也不保证可用性。