/**
 * 运行时组合根：enabled === true 之后才存在。
 *
 * 生命周期约定（工作流 §3.1）：
 *  - `start()` 幂等；注册 adapter（P1）、初始化身份（device.json）、准备状态；
 *    浏览器/网络仍然懒启动（第一次真实请求才由 backend.start() 触发）。
 *  - `dispose()` 幂等；注销 adapter、关闭后端、清定时器、释放锁。
 */

import type { FreetokenConfig } from './config.js'
import { createAdapter, type AdapterDeps } from './adapter/adapter.js'
import { PROVIDER } from './adapter/models.js'
import { createStatusStore, disabledSnapshot, type StatusStore } from './status.js'
import { loadedKeysSnapshot, onLazyLoaded } from './lazy/load.js'
import { clearAuth, maskToken, readAuth, saveAuth, type StoredAuth } from './transport/auth.js'
import { adoptPageCredential, classifyCredentialFailure } from './transport/credential.js'
import { credentialAgeMs } from './transport/credential-age.js'
import { probeAuth, type ProbeResult } from './transport/probe.js'
import type { FreetokenOps } from './commands.js'
import { ensureLazy } from './lazy/load.js'
import { createUnavailableBackend, type ExecutionBackend } from './transport/backend.js'
import { createLazyBackend } from './transport/lazy-backend.js'
import { ensureDevice } from './transport/identity.js'
import { createStatusApiHandler } from './panel/status-api.js'
import { clearHalt, haltBlocksSend, readHalt, writeHalt } from './transport/halt.js'
import { readUsage, writeUsage } from './transport/usage.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freetokenPath } from './transport/paths.js'

/** 诊断：把异常堆栈落到本机 freetoken/diagnostics（不含凭证），便于真实登录排错。 */
function writeDiagnostic(kind: string, error: unknown): void {
  try {
    const dir = freetokenPath('diagnostics')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${kind}.log`),
      `${new Date().toISOString()}\n${String((error as any)?.stack ?? error ?? 'unknown')}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
  } catch {
    // 诊断落盘失败不得影响主流程
  }
}

export interface FreetokenRuntime {
  readonly status: StatusStore
  readonly ops: FreetokenOps
  start(): void
  dispose(): Promise<void>
}

export interface RuntimeDeps {
  /** 测试注入：覆盖后端/凭证/身份读取。 */
  backend?: ExecutionBackend
  getAuth?: () => StoredAuth | undefined
  /** 测试注入：浏览器登录实现（默认懒加载 vendor browser-login）。 */
  browserLogin?: (options: { timeoutMs: number; onProgress?: (message: string) => void }) => Promise<any>
}

export function createRuntime(
  ctx: any,
  config: FreetokenConfig,
  overrides: RuntimeDeps = {},
): FreetokenRuntime {
  const initial = disabledSnapshot(config)
  initial.enabled = true
  initial.login.loggedIn = Boolean((overrides.getAuth ?? (() => readAuth()))()?.auth?.token)
  const status = createStatusStore(initial)
  /** 指标增量写回 status（M15/M16）；只认已知名字，未知名字忽略。 */
  const bumpMetric = (name: string): void => {
    const metrics = { ...status.snapshot().metrics }
    if (name === 'rhythm.request') metrics.requests += 1
    else if (name === 'titleSaved') metrics.titleSaved += 1
    else if (name === 'coalesced') metrics.coalesced += 1
    else if (name === 'batchSplit') metrics.batchSplit += 1
    else if (name === 'partialFailure') metrics.partialFailure += 1
    else return
    status.update({ metrics })
  }
  const backend =
    overrides.backend ??
    createLazyBackend(config, {
      logger: ctx.logger,
      initialTodayRequests: readUsage()?.count ?? 0,
      onStatus: (patch) => {
        status.update(patch)
        if (patch.rhythm && typeof patch.rhythm.todayRequests === 'number') {
          // 跨重启累计：否则每次重启都把请求计数清零，静默/日预算永不生效（封禁复盘 P1）。
          try {
            writeUsage(patch.rhythm.todayRequests)
          } catch {
            // 落盘失败不阻塞
          }
        }
        // mute/封禁一旦发生，立即落盘；重启后仍拒绝发送，直到解除时间或人工 logout。
        if (patch.safety) {
          try {
            if (patch.safety.halted) {
              writeHalt({
                halted: true,
                reason: patch.safety.haltReason ?? 'muted',
                mutedUntil: patch.safety.mutedUntil ?? null,
                at: Date.now(),
              })
            }
          } catch {
            // 落盘失败不阻塞
          }
        }
      },
      onMetric: (name) => bumpMetric(name),
      onAuthRefreshed: () => {
        status.update({ login: { loggedIn: true, lastVerifiedAt: Date.now(), lastError: null }, lastFailure: null })
      },
      onAuthFailed: (message: string) => {
        // 自动续签也救不回来：明确标成“需要重新登录”，但**不删凭证**（用户可能只是网络/服务抖动）。
        status.update({
          login: { loggedIn: false, lastVerifiedAt: Date.now(), lastError: message },
          lastFailure: { at: Date.now(), code: 'AUTH', message },
        })
      },
    })
  const getAuth = overrides.getAuth ?? (() => readAuth())

  /**
   * 把凭证年龄写进 status（S1.4）。
   *
   * 为什么不塞进每个 login patch：`status.update()` 对嵌套对象是整体替换，
   * 每个调用点都重复填一遍容易漏/填错。这里统一从 `auth.json` 现算。
   */
  const refreshCredentialAge = (): void => {
    try {
      const auth = overrides.getAuth ? overrides.getAuth() : readAuth()
      const age = credentialAgeMs(auth?.savedAt, Date.now())
      const snapshot = status.snapshot()
      status.update({ login: { ...snapshot.login, credentialAgeMs: age } })
    } catch {
      // 观测失败不影响主流程
    }
  }

  /**
   * 探活/登录拿到可信身份后回填稳定账号 id。
   *
   * 为什么必须回填：vendor 的会话槽/投喂链归属键优先用 `user.id`；没有它就只能退回
   * `token|cookie`，而那两者每次刷新都会变 ⇒ 每刷新一次凭证就被当成“换了账号”，
   * 会话与投喂链被重置（用户看到“聊着聊着上下文断了 / 网页端又新建窗口”）。
   */
  const persistVerifiedIdentity = (
    user: { id?: string; display?: string } | undefined,
  ): StoredAuth | undefined => {
    if (!user?.id && !user?.display) return undefined
    const current = readAuth()
    if (!current?.auth?.token) return undefined
    const merged = adoptPageCredential(current, {
      ...(typeof user.id === 'string' && user.id ? { userId: user.id } : {}),
      ...(typeof user.display === 'string' && user.display ? { displayName: user.display } : {}),
    })
    if (!merged) return current
    try {
      saveAuth(merged)
      return merged
    } catch {
      return current
    }
  }
  let adapterDisposer: (() => void) | undefined
  /** 凭证年龄刷新定时器的清理函数（dispose 时必须停，避免宿主退出后仍挂着）。 */
  let ageDisposer: (() => void) | undefined
  let started = false
  let disposed = false

  const ops: FreetokenOps = {
    async login(token: string) {
      const value = token.trim()
      if (!value) {
        // 浏览器登录：懒加载 vendor 捕获逻辑（首次真实登录时才加载 Edge/CDP）。
        try {
          const loginModule = overrides.browserLogin
            ? undefined
            : await ensureLazy<any>('transport/browser-login')
          if (loginModule) {
            // 关键：先清掉旧的登录 profile。否则 Edge 会带着**已失效的旧登录态**直接打开，
            // 捕获到的是旧 token（真机 2026-10-20：重登后仍 AUTH invalid token）。
            try {
              loginModule.clearBrowserLoginProfile?.()
            } catch {
              // 清理失败仍继续；用户可在窗口里手动退出后登录
            }
          }
          const login = overrides.browserLogin ?? loginModule.browserLogin
          const outcome = await login({
            timeoutMs: 5 * 60_000,
            onProgress: (message: string) => ctx.logger?.info?.(`freetoken: login: ${message}`),
          })
          if (!outcome?.ok || !outcome?.auth?.token) {
            return {
              ok: false,
              message: `freetoken: browser login failed: ${outcome?.message ?? 'unknown'}${outcome?.reason ? ` (${outcome.reason})` : ''}`,
            }
          }
          const captured = outcome.auth
          saveAuth({
            version: 1,
            account: {
              id: 'default',
              ...(captured?.user?.display ? { displayName: String(captured.user.display) } : {}),
            },
            auth: {
              token: String(captured.token),
              ...(captured.cookie ? { cookie: String(captured.cookie) } : {}),
              ...(captured.hifDliq ? { hifDliq: String(captured.hifDliq) } : {}),
              ...(captured.hifLeim ? { hifLeim: String(captured.hifLeim) } : {}),
              ...(captured.userAgent ? { userAgent: String(captured.userAgent) } : {}),
              ...(captured.wasmUrl ? { wasmUrl: String(captured.wasmUrl) } : {}),
              ...(captured.extraHeaders && typeof captured.extraHeaders === 'object'
                ? { extraHeaders: { ...captured.extraHeaders } }
                : {}),
            },
            // 登录捕获到账号 id 就一并落盘：让 vendor 的会话/链归属键在 token 刷新后保持稳定。
            ...(captured?.user?.id ? { userId: String(captured.user.id) } : {}),
            savedAt: Date.now(),
          })
          status.update({ login: { loggedIn: true, lastVerifiedAt: Date.now(), lastError: null } })
          // 新凭证：作废传输层页面上的旧登录态（真实链路才需要；测试注入的登录不碰浏览器）。
          if (!overrides.browserLogin) {
            try {
              await backend.resetCredentialSession?.()
            } catch {
              // 清理失败不影响登录结果；下一次请求前仍会做页面同步
            }
          }
          // 捕获后立刻用页面内 fetch 只读探活一次（零额度）：避免把已失效的 token 当成功。
          // 测试注入 browserLogin 时跳过（不启动真实浏览器）。
          try {
            if (!overrides.browserLogin) {
              const savedAuth = readAuth() as StoredAuth
              const check: any = backend.probe ? await backend.probe(savedAuth) : { ok: true }
              if (!check.ok) {
                const errorText = String(check.error ?? 'probe failed')
                const authFailed = classifyCredentialFailure(errorText) === 'auth'
                status.update({
                  // 网络抖动不写“未登录”（否则一次断网就误报登录断掉）；凭证类失败才降级。
                  login: { loggedIn: !authFailed, lastVerifiedAt: Date.now(), lastError: errorText },
                  lastFailure: { at: Date.now(), code: authFailed ? 'AUTH' : 'TRANSIENT', message: errorText },
                })
                if (authFailed) {
                  return {
                    ok: false,
                    message: `freetoken: login captured but probe failed: ${errorText}（请确认账号在 Edge 窗口里确实已登录后重试）`,
                  }
                }
                return {
                  ok: true,
                  message: `freetoken: login captured (${maskToken(String(captured.token))}); probe transiently failed: ${errorText}`,
                }
              }
              if (check.user) persistVerifiedIdentity(check.user)
              if (!check.user?.id) {
                ctx.logger?.warn?.(
                  'freetoken: login captured but probe returned no user id; account identity may fall back to token|cookie ' +
                    '(conversation continuity across token rotation is weaker)',
                )
              }
            }
          } catch {
            // 探活不可用不推翻捕获结果；真实请求会再暴露问题
          }
          return { ok: true, message: `freetoken: browser login captured (${maskToken(String(captured.token))})` }
        } catch (error: any) {
          writeDiagnostic('login-error', error)
          return { ok: false, message: `freetoken: browser login error: ${error?.message ?? error}` }
        }
      }
      saveAuth({
        version: 1,
        account: { id: 'default' },
        auth: { token: value },
        savedAt: Date.now(),
      })
      // 手工 token 同样是“新凭证”：清掉页面上旧凭证的登录态，避免下一页把旧 token 当新的。
      if (!overrides.browserLogin) {
        try {
          await backend.resetCredentialSession?.()
        } catch {
          // 清理失败不影响登录结果
        }
      }
      const saved = readAuth() as StoredAuth
      const result = backend.probe ? await backend.probe(saved) : await probeAuth(saved)
      const errorText = result.ok ? null : String(result.error ?? 'probe failed')
      // 只有授权类失败才把状态降成“未登录”；网络/5xx/429 只记错误，不误报登录断掉。
      const authFailed = !result.ok && classifyCredentialFailure(errorText) === 'auth'
      if (result.ok && result.user) persistVerifiedIdentity(result.user)
      status.update({
        login: {
          loggedIn: result.ok || !authFailed,
          lastVerifiedAt: Date.now(),
          lastError: errorText,
        },
        lastFailure: result.ok
          ? null
          : { at: Date.now(), code: authFailed ? 'AUTH' : 'TRANSIENT', message: String(errorText) },
      })
      if (result.ok) {
        return { ok: true, message: `freetoken: logged in (token ${maskToken(value)}); probe ok` }
      }
      if (!authFailed) {
        return {
          ok: true,
          message: `freetoken: token saved (${maskToken(value)}); probe transiently failed: ${errorText}`,
        }
      }
      return {
        ok: false,
        message: `freetoken: token saved (${maskToken(value)}) but probe failed: ${errorText}`,
      }
    },
    async logout() {
      const removed = clearAuth()
      // 人工恢复：logout 同时解除熔断（用户明确要求停止/重置）。
      clearHalt()
      // 退出登录也要清掉传输层页面上旧凭证的登录态：否则常驻 headless 浏览器仍以旧账号在线，
      // 站点自己的 JS 还在跑（既不干净，也会让下一次登录的页面状态看起来“已登录”）。
      try {
        await backend.resetCredentialSession?.()
      } catch {
        // 清理失败不影响退出结果
      }
      status.update({
        login: { loggedIn: false, lastVerifiedAt: null, lastError: null, credentialAgeMs: null },
        safety: { testAccountOnly: config.safety.testAccountOnly, mutedUntil: null, halted: false, haltReason: null },
      })
      return { ok: true, message: removed ? 'freetoken: credentials cleared' : 'freetoken: no credentials stored' }
    },
    async probe() {
      const auth = readAuth()
      if (!auth?.auth?.token) {
        status.update({ login: { loggedIn: false, lastVerifiedAt: Date.now(), lastError: 'missing credential' } })
        return { ok: false, message: 'freetoken: not logged in; run /freetoken login <token>' }
      }
      // 探活也是网页请求：优先走后端的页面内 fetch（会懒启动浏览器），
      // 测试注入的后端没有 probe 时才退回可注入的 fetch 实现。
      let result: ProbeResult
      try {
        result = backend.probe ? await backend.probe(auth) : await probeAuth(auth)
      } catch (error: any) {
        // 探活器本身起不来（浏览器/传输层异常）不是凭证失效：保持登录态，只记录错误。
        const message = `probe unavailable: ${error?.message ?? error}`
        status.update({
          login: { loggedIn: status.snapshot().login.loggedIn, lastVerifiedAt: Date.now(), lastError: message },
        })
        return { ok: false, message: `freetoken: probe failed: ${message}` }
      }
      if (result.ok) {
        if (result.user) persistVerifiedIdentity(result.user)
        status.update({
          login: { loggedIn: true, lastVerifiedAt: Date.now(), lastError: null },
          lastFailure: null,
        })
        return { ok: true, message: `freetoken: probe ok${result.user?.display ? ` (${result.user.display})` : ''}` }
      }
      const errorText = String(result.error ?? 'probe failed')
      const authFailed = classifyCredentialFailure(errorText) === 'auth'
      status.update({
        login: {
          // 网络/服务抖动时保留原登录态，避免一次超时就把面板打成“未登录”。
          loggedIn: authFailed ? false : status.snapshot().login.loggedIn,
          lastVerifiedAt: Date.now(),
          lastError: errorText,
        },
        lastFailure: { at: Date.now(), code: authFailed ? 'AUTH' : 'TRANSIENT', message: errorText },
      })
      return {
        ok: false,
        message: `freetoken: probe failed: ${errorText}${authFailed ? '' : '（网络/服务抖动，凭证仍保留）'}`,
      }
    },
  }

  return {
    status,
    ops,

    start(): void {
      if (started || disposed) return
      started = true

      onLazyLoaded((keys) => status.update({ lazyLoaded: [...keys] }))

      try {
        const device = ensureDevice()
        status.update({
          identity: {
            deviceId: device.deviceId,
            backend: config.backend,
            singleInstance: config.identity.singleInstance,
          },
        })
      } catch (error: any) {
        ctx.logger?.warn?.(`freetoken: device identity unavailable: ${error?.message ?? error}`)
      }

      // 上次 mute/封禁落盘：重启后继续停发，不因重启而绕过熔断（D26/R16）。
      try {
        const halt = readHalt()
        if (halt && haltBlocksSend(halt)) {
          status.update({
            safety: {
              testAccountOnly: config.safety.testAccountOnly,
              mutedUntil: halt.mutedUntil,
              halted: true,
              haltReason: halt.reason,
            },
          })
          ctx.logger?.warn?.(
            `freetoken: sending stays HALTED from persisted state (${halt.reason}; until ${
              halt.mutedUntil ? new Date(halt.mutedUntil).toISOString() : 'manual reset'
            })`,
          )
        }
      } catch (error: any) {
        ctx.logger?.warn?.(`freetoken: halt state unavailable: ${error?.message ?? error}`)
      }

      const deps: AdapterDeps = {
        config,
        getAuth,
        backend,
        ctx,
        logger: ctx.logger,
        onNarration: (input) => {
          status.update({
            narration: {
              model: input.model ?? null,
              local: input.local ?? null,
              dedupeSuppressed: input.suppressed ?? 0,
            },
          })
          if (input.local) ctx.logger?.info?.(`freetoken: local narration: ${input.local}`)
        },
        onMetric: (name) => bumpMetric(name),
      }
      const adapter = createAdapter(deps)
      if (ctx?.llm?.registerAdapter) {
        adapterDisposer = ctx.llm.registerAdapter([PROVIDER], adapter)
      } else {
        ctx.logger?.warn?.('freetoken: llm service unavailable; adapter was not registered')
      }

      status.update({ started: true, phase: 'idle' })
      refreshCredentialAge()

      /**
       * S2.3：启用且已有凭证时**主动把传输层会话拉起来**（不再等第一次请求）。
       *
       * 为什么这对"登录态稳定"是关键：站点维持会话靠的是它自己网页里的 JS 一直在跑
       * （轮询/活动）。以前只有发请求才启动浏览器，空闲时段页面不在线 —— 会话冷却、
       * 下一次请求前就得重新“冒充”登录。现在启用即常驻。
       *
       * 约束：只在 enabled 且**有凭证**时触发；失败只记日志、不影响启动（首次请求会再试）。
       * 必须经 `lazy` 后端（重模块），且不阻塞 start()。
       */
      if (config.autoStartWarmSession) {
        // 🔴 预热必须**异步**（不阻塞 start 的同步段）：否则 `apply()` 返回时
        // 重模块已经被加载，`check-disabled-audit` 的"enabled-idle 不加载任何重模块"
        // 断言就会在**有凭证的真实环境**下变红（离线用例无凭证才侥幸通过）。
        // 让出一个微任务即可把加载推迟到 start() 之后。
        setTimeout(() => {
          void (async () => {
            try {
              // 插件可能在这之前已被卸载（dispose）⇒ 不得再把浏览器拉起来。
              if (disposed) return
              const auth = readAuth()
              if (!auth?.auth?.token) return
              await backend.start()
              if (disposed) return
              status.update({ browser: { running: true, pid: null } })
              ctx.logger?.info?.('freetoken: transport session warmed up (background keep-alive active)')
            } catch (error: any) {
              ctx.logger?.warn?.(`freetoken: warm-up skipped (${error?.message ?? error})`)
            }
          })()
        }, 0)
      }

      /**
       * 凭证年龄写进 status（S1.4）。
       *
       * 放在这里而不是每个 login patch 里：`status.update()` 的嵌套对象是**浅合并**，
       * 只写 `login.loggedIn` 不会抹掉 `credentialAgeMs`；但年龄需要**随时间推移自己变旧**，
       * 所以要在面板轮询时刷新，而不是只在启动时算一次。
       */
      const ageTimer = setInterval(() => refreshCredentialAge(), 60_000)
      ;(ageTimer as any).unref?.()
      ageDisposer = () => clearInterval(ageTimer)

      // host status API（面板消费；只在启用态注册，关闭态零副作用）。
      const registerStatusApi = (scope: any): void => {
        try {
          const webServer = scope?.webServer ?? scope?.get?.('webServer')
          if (!webServer || typeof webServer.register !== 'function') return
          const install = (): (() => void) =>
            webServer.register({
              kind: 'prefix',
              path: '/freetoken/api',
              handler: createStatusApiHandler(() => status.snapshot()),
            })
          if (typeof ctx.effect === 'function') ctx.effect(install, 'freetoken.web-api')
          else install()
        } catch (error: any) {
          ctx.logger?.warn?.(`freetoken: status API unavailable: ${error?.message ?? error}`)
        }
      }
      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['webServer'], registerStatusApi)
        } catch (error: any) {
          ctx.logger?.warn?.(`freetoken: webServer injection failed: ${error?.message ?? error}`)
        }
      } else {
        registerStatusApi(ctx)
      }

      ctx.logger?.info?.(
        `freetoken: enabled (provider=${PROVIDER}, transport=${config.transport}, backend=${backend.kind}, ` +
          `narration=${config.narration.enabled}, localTitle=${config.localTitle.enabled}, ` +
          `contextFeed=${config.session.contextMode})`,
      )
    },

    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      started = false
      try {
        ageDisposer?.()
      } catch {
        // 清理失败不阻塞卸载
      }
      ageDisposer = undefined
      try {
        adapterDisposer?.()
      } catch {
        // 注销失败不阻塞卸载
      }
      adapterDisposer = undefined
      try {
        await backend.close()
      } catch {
        // 关闭失败保留错误给下一次启动清理
      }
      status.update({
        started: false,
        phase: 'idle',
        browser: { running: false, pid: null },
        lock: { held: false, heldBy: null, heldMs: 0 },
        queue: { pending: 0, maxPending: config.queue.maxPending },
      })
      status.update({ lazyLoaded: loadedKeysSnapshot() })
      ctx.logger?.info?.('freetoken: disabled — runtime disposed')
    },
  }
}
