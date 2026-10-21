# dsh-freetoken

Unofficial DSH plugin that bridges **chat.deepseek.com web** into DeepSeek Harness as the
`deepseek-web` provider. Development-only helper; **disabled by default**.

> ⚠️ **Risk notice / 风险声明**
> This plugin drives a private web interface of chat.deepseek.com. That may violate
> DeepSeek's terms of service and can lead to rate limiting or account suspension.
> It is **not** affiliated with or endorsed by DeepSeek. Use it only with an
> expendable (non-critical) account, and accept full responsibility. "Free token"
> does not mean "free of risk".

## 状态

| 项 | 值 |
|---|---|
| 版本 | 0.3.2（真实链路已打通：登录/文本/工具/图片） |
| provider id | `deepseek-web`（显示名 `DeepSeek 网页`） |
| 配置命名空间 / 日志前缀 | `freetoken` / `freetoken:` |
| 默认 | `enabled: false`（零副作用） |
| 构建 | tsc → `lib/`（逐文件 ESM，保留懒加载边界）；client 面板同目录 classic script |
| 验证 | 构建 0 错；离线 30/30；真实 E2E：文本/文件读写+grep/图片理解 |

> 验证口径为作者本地环境的最后一次实测记录，不构成对所有环境的保证。

## 环境要求

| 项 | 要求 |
|---|---|
| DSH | Desktop 0.2.1-rc.2 或更新 |
| Node | `^22.18.0 \|\| >=24.11.0` |
| 浏览器 | Edge 或 Chrome（需支持 CDP；登录与 PoW 求解都在真实浏览器页内完成） |
| 平台 | Windows x64 已实测；macOS / Linux 未实测 |

## 构建与测试

```powershell
npm install
node scripts/build.mjs
node tests/run-offline.mjs
```

## 安装

插件可从 **GitHub 地址**、**本地目录**或 **npm 包名**三种方式安装（DSH 的
`dsh plugin add` / 设置页「添加插件」均支持）。

### 方式一：从 GitHub 安装（推荐，无需手动构建）

```powershell
dsh plugin --profile freetoken-web add https://github.com/ZHANG-923-ZE/dsh-freetoken
```

DSH 会自行 clone 并以 pnpm 安装该仓库（仓库根即 npm 包根，`main` 分支为默认分支）。

### 方式二：本地目录安装

```powershell
git clone https://github.com/ZHANG-923-ZE/dsh-freetoken.git
cd dsh-freetoken
npm install
node scripts/build.mjs        # 必须先构建：lib/ 是产物，不入库
dsh plugin --profile freetoken-web add "link:<你的绝对路径>\dsh-freetoken"
```

> `lib/` 不在版本库里（见 `.gitignore`），所以走本地目录时**必须先跑一次构建**，
> 否则插件装上后没有 `lib/index.js` 可加载。

### 方式三：桌面端图形界面

DSH 设置 → 插件 → 「添加插件」，输入框直接填
`https://github.com/ZHANG-923-ZE/dsh-freetoken`（界面接受包名 / GitHub 仓库地址 / 本地目录路径）。

### 启用

插件**默认关闭**（`enabled: false`，零副作用）。启用有两种方式：

- 在 profile 的 `cordis.patch.yml` 里覆盖：

  ```yaml
  - id: freetoken
    config:
      enabled: true
  ```

- 或在 DSH 设置 → `dsh-Freetoken` 面板中启用（面板本身在关闭态也可打开，用于查看状态）。

启用后用 `/freetoken login` 完成登录（见下方「命令」）。

### 隔离 profile（推荐先用隔离环境试跑）

```powershell
$env:DSH_HOME="C:\Users\<you>\AppData\Local\Temp\freetoken-test-home"
dsh plugin --profile freetoken-web add https://github.com/ZHANG-923-ZE/dsh-freetoken
# 在 profile 的 cordis.patch.yml 里 - id: freetoken config.enabled: true
dsh --profile freetoken-web --no-open --port 61888
```

desktop profile 安装前先备份 `package.json / pnpm-lock.yaml / cordis.patch.yml`，
并禁用基座插件 `dsh-deepseek-web-login`（同 provider id 会 DUPLICATE_ADAPTER）。

### 卸载与回滚

1. `dsh plugin --profile <name> remove dsh-freetoken`；
2. 删除 `cordis.patch.yml` 里 `id: freetoken` 的覆盖项（否则 compose 仍报缺包）；
3. Windows/pnpm 有时留下 `node_modules/dsh-freetoken` 悬空 junction —— 手工删除；
4. 需要恢复原状时还原步骤 0 的三个快照文件；`freetoken/` 状态目录可保留或整目录删除。

## 配置（profile 的 cordis.patch.yml 覆盖）

```yaml
- id: freetoken
  config:
    enabled: true
    transport: browser          # 仅 browser；PoW 必须在真实浏览器页内完成
    backend: cdp                # cdp 已实现；dom 为长期可插拔选项（明确报错）
    narration: { enabled: true, dedupeWindowMs: 90000, maxRepeats: 2 }
    localTitle: { enabled: true, maxChars: 32 }
    rhythm:
      jitterMs: { min: 2000, max: 5000 }   # 对数正态，禁止固定周期
      maxCallsPerTurn: 1                    # 一轮只发一次（0.5.0 起，阻止连发）
      silenceMs: { min: 60000, max: 120000 }
      silenceScale: { perRequests: 5, stepMs: 120000, capMs: 600000 }
      dailyBudget: 20                       # 硬性日上限（0 = 不限制）
      # 滚动窗口限速：任意 rateWindowMs 内最多 rateMaxInWindow 次。
      # 比日预算精细 —— 日预算防总量，这条防"短时突发"（封禁的真实形态）。
      rateWindowMs: 1800000
      rateMaxInWindow: 6
      # 连续请求长休：连续 N 次后强制休息 3–5 分钟（"连续跑"比"总量多"更像脚本）。
      longRunThreshold: 5
      longRunBreakMs: { min: 180000, max: 300000 }
    retry: { maxRetries: 3, baseDelayMs: 5000, factor: 2, maxDelayMs: 120000, jitterRatio: 0.3 }
    safety: { testAccountOnly: true, haltOnMute: true, minRequestGapMs: 60000 }
    protocol: { autoContinue: false }      # 不自动续写（每轮续写都是一次真实请求）
    session:
      reuseTurns: 20
      cleanup: deferred
      # 上下文投喂方式（0.4.0 起默认 chained）
      #   chained：每轮只发增量，且**不轮换会话** ⇒ 一个 DSH 会话长期对应同一条网页版会话。
      #            代价：工具协议只存在于链首那条消息里，服务端丢早期上下文时模型可能不按
      #            约定格式发工具调用（插件遇不确定会自动退回全量重发）。
      #   full   ：每轮重发全量，最稳但请求体随对话线性增长（实测单轮可达 21 万字符）。
      contextMode: chained
      # 凭证年龄预检（0 = 关闭）。超过它就先用页面续签一次，避免任务中途撞 401。
      credentialRefreshAgeMs: 5400000
    # 启用且已有凭证时预热并常驻传输层会话（站点自己的 JS 会维持登录态）。
    # false = 退回旧行为（第一次真实请求才懒启动）。
    autoStartWarmSession: true
```

## 命令

- `/freetoken status` — 只读：登录/锁/队列/静默/今日请求/最近拦截/最近失败/旁白/指标。
- `/freetoken login` — 拉起独立 Edge 窗口手动登录，自动捕获 token/cookie/指纹头到 `~/.dsh/freetoken/auth.json`。
- `/freetoken logout` — 清除本地凭证。
- `/freetoken probe` — 只读探活（页面内 fetch，零额度；会懒启动浏览器）。

命令必须在输入框以 `/freetoken ...` 形式执行；它声明了 input，不会当聊天文本发出去。

## 与其他 provider 并存（网页版 / 官方 API）

本插件**不占用**任何已有的 provider：它只是新增一个 `deepseek-web`（显示名「DeepSeek 网页」），
和宿主自带的 `deepseek-account`（官方 API）以及其它第三方 provider **并列共存**。
在模型选择器里各自独立列出，随时切换，互不影响。

| | `deepseek-web`（本插件） | `deepseek-account`（官方 API） |
|---|---|---|
| 入口 | 模型选择器 → 「DeepSeek 网页」 | 模型选择器 → 官方 DeepSeek |
| 凭证 | 浏览器登录态（`/freetoken login`） | API key |
| 额度 | 网页版免费额度，**有速率限制** | 按量计费 |
| 稳定性 | 约 2 小时需重登；有风控风险 | 稳定 |
| 适合 | 偶尔问几句、非关键任务 | 长任务、工具循环、agent 工作负载 |

**什么时候用哪个**（建议）：

- 日常随手问 → 用「DeepSeek 网页」（免费）
- 要跑工具循环 / 长任务 / 无人值守 → **用官方 API**（网页版会被风控盯上）
- 网页版被限流或掉登录 → 直接切官方 API，不用改任何配置

**注意**：两个 provider 的**会话上下文互不相通**（各自独立的历史）。同一个 DSH 会话里
切换 provider，等于换了一个模型后端，之前网页版链式投喂的上下文不会被官方 API 继承。
需要连续上下文时，整个会话用一个 provider 跑完。

**模型 id 撞名提醒**：网页版的两个模型沿用 `deepseek-chat` / `deepseek-reasoner`，
与官方 API 的 id 相同 —— 这**不影响**选择（宿主按 provider + model 二元组区分），
但有两处要留意：

- 走网页版时如果传了未收录的模型 id（例如官方 API 的 `deepseek-v3.2`），
  插件会**回退到快速模式**（`resolveSpec` 的兜底），不会报错但也不是你选的那个；
  需要「深度思考」请显式选 `deepseek-reasoner`。
- 反过来，官方 API 不认识网页版的两个 id 时按它自己的规则处理，与本插件无关。

## 数据与安全

- 所有状态在 `${DSH_HOME:-~/.dsh}/freetoken/`：`auth.json`、`device.json`、`browser-profile/`、
  `transport-profile/`、`sessions-in-use.json`、`resume-state.json`、`diagnostics/`。
- 凭证不进仓库/日志/prompt；日志只出现掩码。
- 默认节奏：发送前 2–5s 对数正态抖动、失败 5s 起指数退避+抖动、AUTH/mute/QUOTA 不重试、
  每 20 次请求后 30–60s 静默。出现 `AUTH`/mute 立即停止，不自动换号。

## 会话常驻与登录态（0.4.0）

这一版把“凭证快照 + 跨浏览器重放”改成“单一会话本体”，目的是让后台的网页版登录
**持续在线**，而不是到点就断：

- **传输层 profile 不再每次重建**：站点写给这个浏览器的 cookie/localStorage 会跨启动保留
  （只清运行时句柄 `DevToolsActivePort` / `lockfile` / `Singleton*`，不动登录态）。
- **`autoStartWarmSession`**：启用且已有凭证时就把后台浏览器拉起来常驻，由站点自己的 JS
  维持会话（不再等第一次请求）。设 `false` 可退回旧的懒启动行为。
- **常驻守护（keep-alive）**：每 60s×[0.7,1.3] 做一次**本地 CDP 探测（零网络）**，
  判定 alive / off-origin / logged-out / dead：
  - 页面被导航走 ⇒ 拉回站点（同一情况最多试 2 次）；
  - 页面丢登录态 ⇒ 作废页面签名，下一次请求自动重装；
  - 浏览器被关掉/崩了 ⇒ 连续 3 次探测失败后**自动重新拉起**（误关也能自愈），
    失败按 60s×2ⁿ 退避（上限 30 分钟），连续 5 次仍失败则停表等下一次真实请求；
  - ⚠️ **有请求在飞时绝不重启浏览器**（否则会掐断正在输出的回答）。
- **`/freetoken status`** 会显示 `session: mode=... | keep-alive=...`，
  面板可据此判断“后台会话是否常驻”。

## 懒加载与关闭态

- 轻模块：`index.ts` / `config.ts` / `status.ts` / `commands.ts` / `lifecycle.ts`。
- 重模块（浏览器、webapi、PoW、SSE、协议解析、节奏控制器、会话清理）只能经
  `src/lazy/load.ts` 动态加载；关闭态不加载、不注册 provider、不发请求、不起进程。
- 验收：`tests/check-disabled-audit.mjs`、`tests/check-lazy-import.mjs`。

## 面板

启用后：设置 → `dsh-Freetoken`。显示登录/身份/浏览器/锁队列/节奏与静默倒计时/今日请求/
最近请求与拦截/重试退避/熔断/最近失败/旁白/指标/懒加载模块；host API 为
`GET /freetoken/api/status`（只读、无凭证）。关闭态显示“已关闭（未启用）”且不轮询。

## 许可

Apache-2.0，衍生自 `cv-superding/dsh-deepseek-web-login`（Apache-2.0，commit cfd684d），
署名见 `NOTICE` 与 `src/transport/vendor/NOTICE.md`。
与 DeepSeek 无关联；网页私有接口可能变更、可能导致账号受限，风险自担；只用非关键账号测试。

## 贡献与反馈

- Issue：https://github.com/ZHANG-923-ZE/dsh-freetoken/issues
- 报告问题时请附上 `freetoken:` 前缀日志片段（**先掩码 token / cookie**）与你的
  DSH 版本、Node 版本、平台；不要贴任何凭证。
- 改动请保持既有工程约束：关闭态零副作用、重模块只能经 `src/lazy/load.ts` 懒加载、
  日志前缀统一 `freetoken:`、`transport/egress.ts` 是唯一 `fetch` 出口。
- 提交前请跑通 `node scripts/build.mjs` 与 `node tests/run-offline.mjs`。
- 完整工程约定见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。
- **安全问题请勿公开开 issue**，见 [`SECURITY.md`](SECURITY.md)（含私下报告渠道）。

## 仓库结构

```
src/            TypeScript 源码（按 adapter / protocol / rhythm / session / transport 分层）
  lazy/load.ts  唯一的动态 import 入口（重模块懒加载边界）
  transport/vendor/  来自上游基座的衍生代码，署名见该目录 NOTICE.md
tests/          离线用例（check-*.mjs），总入口 run-offline.mjs
scripts/build.mjs      tsc 逐文件 ESM 构建到 lib/
.github/workflows/ci.yml   CI：ubuntu + windows 构建与测试
```

CI 在每次 push / PR 时自动跑 `npm ci` → `npm run build` → `npm test`，
Windows 与 Linux 双平台。
