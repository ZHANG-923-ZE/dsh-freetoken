# Contributing to dsh-freetoken

Thanks for considering a contribution. This document describes the workflow and the
engineering constraints the project expects every change to respect.

## 约定（不可违反）

1. **关闭态零副作用**：`enabled: false` 时不得注册 provider、加载重模块、读写凭证、
   启动浏览器、发起请求、创建定时器或挂载会话钩子。唯一例外是只读的
   `/freetoken status`（由 `statusCommand` 控制）。
2. **禁止跨对话合并请求**；所有网页请求必须经过 `RhythmController`。
   `src/transport/egress.ts` 是唯一的 `fetch` 持有者。
3. **显式配置**：不使用 `NODE_ENV` 判断行为；`mode` 只影响日志。
4. **不重写** PoW、登录捕获、SSE 解析（除非确有缺陷）。
5. **静默期禁止生成讲解请求**；本地讲解不得进入聊天正文或发往网页端。
6. **凭证红线**：token / cookie / 反爬指纹头只允许存放在 `<DSH_HOME>/freetoken/`，
   绝不进入仓库、日志或提示词。日志中只能出现掩码。
7. **证据驱动**：任何结论都要有可核验的证据（测试输出、日志片段、截图），
   无证据不算完成。

## 开发流程

```powershell
npm install
node scripts/build.mjs        # tsc 逐文件 ESM，保留懒加载边界
node tests/run-offline.mjs     # 离线用例总入口
```

- 构建用 `tsc` 逐文件输出到 `lib/`，**不打包**——这样才能保留 `src/lazy/load.ts`
  的动态导入边界。
- 源码中除 `src/lazy/load.ts` 外**禁止**出现动态 `import()`；轻模块不得静态引用重模块。
- 每条关键判据都要有反向验证：改坏实现时对应用例必须变红。

## 提交前检查

- [ ] `node scripts/build.mjs` 通过
- [ ] `node tests/run-offline.mjs` 通过
- [ ] 未提交 `lib/`、`node_modules/`、`*.tgz`、本机绝对路径
- [ ] 未提交任何凭证（token / cookie / 账号信息）
- [ ] 日志前缀为 `freetoken:`，未混入上游基座前缀
- [ ] 关闭态审计与懒加载边界用例仍然通过

## 衍生代码

`src/transport/vendor/` 下的文件来自
[`cv-superding/dsh-deepseek-web-login`](https://github.com/cv-superding/dsh-deepseek-web-login)
（Apache-2.0，commit `cfd684d`），说明见 `src/transport/vendor/NOTICE.md`。
修改这些文件时，请在同目录的 NOTICE 中记录改动点。

## 许可

提交即表示你同意你的贡献以 Apache-2.0 授权。