# Changelog

## 0.1.0 — 2026-10-20（P0 脚手架）

- 项目落位：`8.12-Freetoken`，代码仓 `8.12.4-Src`，包名 `dsh-freetoken`。
- 配置模型：`freetoken` 命名空间，默认 `enabled:false`，含 batch/queue/coalesce/localTitle/rhythm/session/protocol/prompt 全量默认值（归一化 + 边界夹取）。
- 生命周期门：`apply()` 在关闭态零副作用；仅可按 `statusCommand` 注册只读 `/freetoken status`。
- 懒加载机制：`src/lazy/load.ts` 为唯一动态 import 入口，加载记账进 status（P1 起登记重模块）。
- 状态骨架：登录/浏览器/锁/队列/静默/今日请求/最近拦截/最近失败/指标字段。
- 构建：tsc 逐文件 ESM（保留模块边界）。
- 离线用例：config 归一化、关闭态审计、懒加载边界、命名空间洁净。

### 已知限制（P0）

- 尚未注册 `deepseek-web` provider（P1）。
- `login/logout/probe` 命令未实现（P1）。
- 无真实网络/浏览器路径与 E2E。

### v1.1 增补（2026-10-20）

- 配置新增 identity/retry/safety/backend/narration 去重/protocol 内容约束；transport 仅保留 browser。
- 抖动默认改为对数正态 2000–5000ms；status 增加 lastRequestAt/msSinceLastRequest/retry/safety/identity 字段。
- 新增工作流增补 8.12.1.2 与验收 M21–M27。


### P1 进行中（2026-10-20）

- provider 契约：自带 LlmAdapter 形状的 `FreetokenLlmAdapterBase` + `FreetokenAdapter`（provider `deepseek-web`，模型两档）。
- 凭证单账号存储（原子写/掩码/损坏容忍）；身份固化 `device.json` + `transport.lock` 单实例；`ExecutionBackend` 接口与不可用占位后端（cdp 真实实现待接）。
- `localTitle`：session-title 本地合成，零网页请求、零凭证（L1）。
- 新增离线用例：adapter 契约、auth/identity、local-title；全套 7/7 PASS。
- 真实 Edge/CDP、页内 PoW、SSE 与 webapi 仍为下一批任务（真实调用当前返回 `BACKEND_NOT_READY`）。


- P1 切片二：`/freetoken login <token>` / `logout` / `probe`（零额度 users/current，可注入 fetch），凭证探活结果写入 status；新增 check-commands。


- P1 切片三：vendor 移植基座传输/SSE/PoW（cfd684d，页内 PoW 无 Node 回退）；eal-backend（单实例锁 + CDP fetch）经 lazy MANIFEST 动态加载；纯函数 prompt/事件翻译；离线 9/9。


- P1 切片四：无 token 的 `/freetoken login` 懒加载 vendor `browserLogin`（Edge/CDP）并落库；修复 vendor 的 `.ts` 导入扩展名改写；离线 10/10。


- P4 前置：`rhythm/retry.ts` 随机退避（指数 ×2、±30% 抖动、上限、可重试码白名单），新增 check-retry，离线 11/11。


- P2 前置：`session/mapping.ts`（按 DSH sessionId 的网页会话槽、复用/轮换/持久化/恢复/淘汰），新增 check-session-store，离线 12/12。


- P4 前置：`rhythm/jitter.ts` 对数正态抖动（区间夹取、非固定周期），新增 check-jitter，离线 13/13。


- P4 前置：`rhythm/daily.ts` 日预算（本地日重置、0=不限），新增 check-daily-budget，离线 14/14。


- P4 前置：`rhythm/burst.ts` 每 turn 调用计数与超限标记，新增 check-burst，离线 15/15。


- P4 前置：`rhythm/silence.ts` 动态静默（基础随机 + 按今日请求数上调/封顶），新增 check-silence，离线 16/16。


- P4 前置：`rhythm/lock.ts` 全局串行锁（FIFO/abort/幂等/统计），新增 check-lock，离线 17/17。


- P4 前置：`rhythm/coalesce.ts` 相同请求 single-flight + 稳定 key，新增 check-coalesce，离线 18/18。


- P3 前置：`protocol/narration.ts`（<narration> 拆分 + 本地讲解模板，零额外请求），新增 check-narration，离线 19/19。


- round 15：status 契约用例（风险指标字段 + 快照深拷贝），离线 20/20。


- round 16：`rhythm/queue.ts` 队列在飞计数（maxPending fail-fast），离线 21/21。


- round 17：`rhythm/metrics.ts`（请求/节省/单飞/拆批/部分失败/中位数，样本有界），离线 22/22。


## 2026-10-20 · 0.2.0（真实链路打通）

- 修复：`/freetoken` 命令声明 input，参数不再被当聊天文本（includes TypeError 根因）。
- 修复：providerRetryPolicy 补全扁平 `retryableCodes`（否则宿主 llm-retry 用未定义字段崩溃）。
- 修复：narration 流式拆分（开/闭合标签、未闭合降级、hold-back 只扣标签前缀）。
- 修复：自动续写判定不再因过滤器 hold-back 看到 0 字。
- 修复：localTitle 从标题任务 JSON 中提取真实用户消息。
- 修复：vendor 路径统一到 `<DSH_HOME>/freetoken/`（browser-profile/transport-profile/gate/context-feed/frames）。
- 新增：protocol/pipeline（工具协议 + 工具解析 + 续写 + narration）、rhythm/backend（唯一出口 + L3 单飞）、session/journal+cleanup（deferred 删除账本）、panel/status-api + client 面板。
- 新增：check-controller / check-rhythm-backend / check-session-cleanup / check-panel-api / check-guard-and-backend。
- 验证：构建 0 错；离线 27/27；真实文本/工具/图片 E2E 通过。

## 2026-10-20 · 0.2.1（封禁事件后的止损修复）

- 修复：mute/封禁识别（中文“封禁/禁言”、mutedUntilMs）→ MUTED 不可重试，立即熔断。
- 修复：熔断落盘 `freetoken/halt.json`，重启后继续停发（之前重启即绕过 D26）。
- 修复：登录 token/cookie 每次成功后回写 + AUTH 续签一次（解决反复 invalid token）。
- 修复：`/freetoken login` 先清空登录 profile，捕获后零额度探活校验。
- 新增：`tests/check-mute-halt.mjs`；离线 28/28。

## 2026-10-20 · 0.3.0（保守模式 + 设置页 v2）

- 保守模式默认值（D33）：全局最小请求间隔 15s、maxCallsPerTurn 2、续写 1 轮、
  静默每 10 次（步长 120s/封顶 600s）、日预算 100、今日请求落盘 usage.json 跨重启累计。
- 设置页 v2：对齐基座插件的主题令牌/卡片/状态药丸/横幅/指标网格/懒加载 chips 设计体系。
- 新增 tests/check-conservative.mjs（最小间隔、跨重启用量、日预算恢复）；离线 29/29。

## 2026-10-20 · 0.3.2（登录态连续性修复：运行中不再“突然断登录”）

现场：真实链路跑一段时间后连续 401（`Authorization Failed (invalid token)`），
只能人工 `/freetoken login`；重登后对话上下文还会被当成“换号”重置。
根因（证据：`8.12.5-Ledgers/evidence/M26-*.md`、`M10-*.md`、`feed-decisions.jsonl`）：

1. **传输层 UA 丢失**：vendor 原本从账号库取 UA 传给 headless 浏览器；单账号构建把
   账号库 shim 成空实现 ⇒ `--user-agent` 静默消失，请求带 `HeadlessChrome` UA。
   `User-Agent` 是 fetch 禁止头，`buildDsHeaders` 里的真实 UA 根本发不出去。
2. **静态快照覆盖活凭证**：页面已经轮换出新 token 时，下一次请求仍用 auth.json 的旧 token
   重新安装并重载页面（把页面从“已登录”降级），随后 401。
3. **没有自动续签**：AUTH 后只读一次页面 token；页面还是旧值就放弃，等人工重登。
   页面丢失登录态时也没有任何机制让下一次请求重装（heartbeat 未接线）。
4. **账号身份不稳定**：auth.json 没有存 `user.id`，vendor 的会话槽/投喂链归属键退回
   `token|cookie`，每刷新一次凭证就被判成“换号”→ 会话/链被退役、全量重发。
5. **状态误报**：探活网络抖动也写 `loggedIn=false`，面板会把“一次超时”读成“登录断开”。

修复：

- 传输层：新增 `setTransportUserAgent()`，启动 headless 前传入登录捕获的 UA（含回收旧会话语义）。
- 请求前把传输层页面上的当前 token/cookie/身份同步回 auth.json（页面优先，绝不空 token 覆盖）；
  页面 token 已一致时对齐安装签名，避免“每请求重载一次页面”的抖动。
- AUTH 后自动续签一次：先采纳页面新凭证；仍不行则重载页面等站点自己换新 token；15s 内拿不到
  才报 `AUTH`，并把 `status.login.lastError` 明确写成“需要重新登录”（不删凭证）。
- 页面丢了登录态（localStorage 无 token）时作废安装签名，下一次请求自动重装。
- `StoredAuth` 新增 `userId`（登录捕获/探活回填），`toWebAuth` 以 `user.id` 传给 vendor；
  重新登录时调用 `resetCredentialSession()` 清掉页面旧凭证登录态。
- 探活/登录失败分类：`HTTP 401/403`、`invalid token`、`授权失败` 才降级“未登录”；
  `fetch failed`/超时/5xx/429 只记录错误，保留登录态。
- 新增 `tests/check-auth-continuity.mjs`（30/30 PASS）；构建 0 错。

复核补强（同一修复批次）：

- `resetCredentialSession` 不再在请求飞行中直接杀浏览器：标记页面凭证不可信 + 注册一次性
  idle 钩子，等 in-flight 归零再回收（否则会掐断流、并把登录探活一起卡住）；传输层加会话代次，
  启动途中被重置的浏览器不会被重新登记（避免旧 UA/旧凭证会话复活）。
- AUTH 续签成功后对齐安装签名（少一次页面重载）、支持取消与“站点已登出”早退；
  `reset` 后到新凭证成功跑完一轮之前，请求前同步**不采纳**页面旧凭证（防把新登录降级回旧 token）。
- 探活也先同步页面凭证；`logout` 一并作废页面登录态。
- 修复**真实链路 mute 永不熔断**：`rhythm/backend` 把封禁/禁言文案映射为 `MUTED`
  （此前被改写成 `AUTH`，controller 收不到 MUTE ⇒ `halt.json` 不落盘、重启即绕过 D26）。
  新增链路级用例（注入 `RATE_LIMIT` + 中文封禁文案 → 断言 `safety.halted` 与 `mutedUntil`）。
- `probeAuth` 识别 HTTP 200 的授权失败信封（`biz_code 40003/40001`），并兼容数字 id /
  `data.user` / `data.biz_data` 形态（此前会假通过、身份静默不回填）。
- 浏览器登录捕获拿不到 `user.id` 时显式告警；探活失败不再把“仅身份变化”写成“刚验证过”。

已知限制：若站点侧会话本身已彻底失效（重载页面也换不出新 token），仍需人工重登一次；
本次保证的是“能自动续就自动续，续不上提前、明确地报，不静默断在任务中途”。

## 2026-10-20 · 0.3.1（设置页 v3 排版优化）

- 分段导航（概览/节奏与请求/诊断）、Hero 状态卡 + 环形日预算、指标 tiles、失败详情、可复制 deviceId、骨架屏与 focus 样式。
- 设计参考 shadcn/ui 令牌化主题与 Lucide 线性图标；仍全部使用宿主主题令牌，无外部资源。
- 构建 0 错、离线 29/29；三 tab 实机截图 evidence/M17-*-v3-*.png。
