/**
 * 真实执行后端（cdp）：唯一重模块入口，必须经 lazy/load.ts 动态加载。
 *
 * 传输/登录/PoW/SSE 复用基座冻结版（vendor/），PoW 已改为页内求解（R14）。
 * 本后端只产出**原始网页事件**；协议序列化/工具解析/narration 在 protocol/pipeline。
 *
 * v0.3.2（2026-10-20 登录态连续性修复）：
 *  - 请求前先把**传输层页面上的当前凭证**同步回 auth.json（页面是活的事实来源，
 *    静态快照只是上一次见到的值；不采纳就会把页面上的新 token 又盖回旧 token）；
 *  - AUTH 后先做一次页面续签（重载页面，等站点自己把 userToken 换新），成功则重试一次；
 *  - 页面丢了登录态（localStorage 无 token）时作废安装签名，下一次 fetch 会重装；
 *  - UA 用登录捕获的真实值启动 headless 传输层（历史缺陷：账号库 shim 让 UA 静默丢失，
 *    请求因此带 HeadlessChrome 指纹，容易被风控判成脚本并让登录态提前失效）。
 */

import type { FreetokenConfig } from '../config.js'
import type { StatusSnapshot } from '../status.js'
import { FreetokenError } from '../adapter/errors.js'
import type { BackendRequest, ExecutionBackend, UploadImageInput } from './backend.js'
import { readAuth, saveAuth, type StoredAuth } from './auth.js'
import { acquireTransportLock } from './identity.js'
import {
  invalidateTransportSession,
  launchBrowserTransport,
  markTransportPageSessionStale,
  navigateTransportToSite,
  noteTransportPageSessionSignature,
  readTransportCookieJar,
  readTransportPageState,
  renewTransportPageCredential,
  setTransportIdleHook,
  setTransportUserAgent,
  transportRequestsInFlight,
} from './vendor/browser-transport.js'
import { buildCookieHeader } from './vendor/browser-login.js'
import { pageSessionFromHeaders } from './vendor/page-session.js'
import {
  adoptPageCredential,
  canAttemptAuthRecovery,
  isSiteOriginUrl,
  toWebAuthShape,
} from './credential.js'
import {
  describeCredentialAge,
  evaluateCredentialAge,
} from './credential-age.js'
import {
  browserAvailable,
  closeEgress,
  installBrowserEgress,
  pageFetch,
  probeViaEgress,
} from './egress.js'
import {
  deleteWebSession,
  setSessionLifecycleHook,
  streamWebCompletion,
  uploadImageFile,
} from './vendor/webapi.js'
import { applyContextMode, readContextModeSetting } from './vendor/context-feed.js'
import { createDeferredCleaner, type DeferredCleaner } from '../session/cleanup.js'
import { removeJournalEntry, upsertJournalEntry } from '../session/journal.js'
import { createTransportKeepAlive, type KeepAlive } from './keep-alive.js'

export interface RealBackendDeps {
  logger?: { info?: (message: string) => void; warn?: (message: string) => void; debug?: (message: string) => void }
  /** 凭证从传输层页面自动刷新后回调（status 回填）。 */
  onAuthRefreshed?: (auth: StoredAuth) => void
  /** 自动续签也救不回来时回调（status 明确显示“需要重新登录”，而不是静默失败）。 */
  onAuthFailed?: (message: string) => void
  /** 状态增量回填（常驻守护的面板可见性依赖它）。 */
  onStatus?: (patch: Partial<StatusSnapshot>) => void
}

/** AUTH 后页面续签的等待上限（站点重启 + 自己刷新 token 的时间）。 */
const AUTH_RENEW_TIMEOUT_MS = 15_000

/**
 * 预检续签失败后的冷却时间（P0-1）。
 *
 * 🔴 为什么必须有：预检失败时 `savedAt` **不会更新**，于是 `due` 状态会永久为真 ——
 * 没有冷却就等于**每个请求前都整页重载一次**（比原来的"撞 401 再报错"更糟，
 * 而且是最容易被风控识别的高频整页加载模式）。
 *
 * 冷却时长取「阈值的一半」与 10 分钟中的较大值：阈值越大说明凭证越老，
 * 越不该频繁重试（同时也不该很快再试 —— 站点侧通常需要更久才能续上）。
 */
function preflightCooldownMs(thresholdMs: number): number {
  const base = Math.max(10 * 60_000, Math.floor(Math.max(0, thresholdMs) / 2))
  return Math.min(base, 60 * 60_000)
}

export function createRealBackend(config: FreetokenConfig, deps: RealBackendDeps = {}): ExecutionBackend {
  const logger = deps.logger
  let started = false
  let releaseLock: (() => void) | undefined
  let cleaner: DeferredCleaner | undefined
  /**
   * 页面凭证是否可信（可作为“当前凭证”写回快照）。
   *
   * 登录/换 token 后置 false：此刻页面仍可能持有**旧**凭证；在它被新凭证重装之前，
   * 请求前同步若采纳页面值就会把新登录“降级”回旧 token。等新凭证成功跑完一轮后再置回 true。
   */
  let pageCredentialTrusted = true
  /** 常驻守护（S2.3–S2.5）；只在 start() 之后存在。 */
  let keepAlive: KeepAlive | undefined
  /** 预检续签失败后的冷却截止时刻（P0-1：防止每个请求都整页重载）。 */
  let preflightCooldownUntil = 0
  /**
   * 本轮请求是否已经试过续签（含预检）。
   *
   * 用途：某一次请求里预检已经 reload 过一次，AUTH 恢复路径就**不要再 reload 第二次**
   * ——否则一次请求最多三次整页重载，比不做预检还糟。
   */
  let renewalTriedThisTurn = false

  const createCleaner = (): DeferredCleaner =>
    createDeferredCleaner({
      // 删除原语仍然只有 vendor 一个出口（页面内 fetch + 确认回执）。
      deleteSession: async (_accountId: string, sessionId: string) => {
        const auth = readAuth()
        if (!auth?.auth?.token) return false
        // 维护型删除也必须用页面上的最新凭证：token 轮换后仍用旧快照会永远 401、账本反复重试。
        const synced = pageCredentialTrusted ? await syncCredentialFromPage(auth) : undefined
        return await deleteWebSession(toWebAuthShape(synced ?? auth), sessionId)
      },
      accountExists: () => Boolean(readAuth()?.auth?.token),
      policy: {
        mode: config.session.cleanup,
        batchRange: config.session.cleanupBatch,
        delayRange: config.session.cleanupDelayMs,
        gapRange: config.session.cleanupGapMs,
      },
      logger,
    })

  /** 读传输层页面当前的 cookie 头（本机 CDP，零网络）。 */
  const readCookieHeader = async (): Promise<string | undefined> => {
    try {
      const jar = await readTransportCookieJar()
      const built = buildCookieHeader(
        jar.filter((item: any) => String(item?.domain ?? '').includes('deepseek')),
      )
      return built || undefined
    } catch {
      return undefined
    }
  }

  /**
   * 把传输层页面上的**当前**登录态同步回 auth.json。
   *
   * 单向：页面 → 快照。页面是站点自己维护的活状态（站点会轮换 token/cookie），
   * 静态快照只是上一次见到的值。请求前同步可避免“拿旧 token 把页面的新 token 盖回去”
   * 以及随后的 401。
   *
   * @returns 有变化时返回合并后的快照；无页面/无 token/无变化返回 undefined。
   */
  const syncCredentialFromPage = async (current: StoredAuth): Promise<StoredAuth | undefined> => {
    try {
      const state: any = await readTransportPageState()
      if (!state) return undefined
      if (!isSiteOriginUrl(String(state.url ?? ''))) return undefined
      const token = String(state.userToken ?? '').trim()
      if (!token) {
        // 页面丢了登录态：作废安装签名，下一次 fetch 会用快照重装。
        // 不这么做的话，站点自己的 JS 会一直停在登出态（既不像真人，也不会替我们续签）。
        markTransportPageSessionStale()
        return undefined
      }
      const cookie = await readCookieHeader()
      const merged = adoptPageCredential(current, {
        token,
        ...(cookie ? { cookie } : {}),
        ...(state.userId ? { userId: String(state.userId) } : {}),
        ...(state.displayName ? { displayName: String(state.displayName) } : {}),
      })
      if (!merged) return undefined
      saveAuth(merged)
      // 页面已经在用这个凭证 ⇒ 把安装签名对齐，避免下一次 fetch 为同一凭证再重载页面。
      // （重载会重新拉起站点 JS，站点可能再次轮换 token，形成“每个请求都重载一次”的抖动。）
      try {
        const sameHifLeim = String(state.hifLeim ?? '') === String(merged.auth.hifLeim ?? '')
        if (sameHifLeim) {
          const writes = pageSessionFromHeaders({
            authorization: `Bearer ${merged.auth.token}`,
            ...(merged.auth.hifLeim ? { 'x-hif-leim': merged.auth.hifLeim } : {}),
          })
          if (writes.length > 0) noteTransportPageSessionSignature(JSON.stringify(writes))
        }
      } catch {
        // 对齐失败只会多一次重载，不影响正确性
      }
      const tokenRotated = merged.auth.token !== current.auth.token
      const identityFilled = !current.userId && Boolean(merged.userId)
      if (tokenRotated || identityFilled) {
        logger?.info?.(
          `freetoken: adopted the transport page credential (token=${tokenRotated ? 'rotated' : 'same'}, identity=${merged.userId ? 'yes' : 'no'}; no account switch)`,
        )
      }
      try {
        // 只有 token 真的更新才算“登录态被验证/刷新”；仅 cookie/身份变化不应把
        // lastFailure 清掉、也不应把 lastVerifiedAt 写成“刚校验过”（那会让面板说谎）。
        if (tokenRotated) deps.onAuthRefreshed?.(merged)
      } catch {
        // 观测失败不影响请求
      }
      return merged
    } catch (error: any) {
      logger?.warn?.(`freetoken: credential sync from transport page failed: ${error?.message ?? error}`)
      return undefined
    }
  }

  /**
   * AUTH 后的一次**页面续签**：重载传输层页面，等站点自己把 `localStorage.userToken`
   * 换成一个新值（站点在会话仍有效时会自行续期）。
   *
   * 这是“不需要用户重新登录”的最后一招；站点续不上（真的登出了）就返回 undefined，
   * 由上层把状态明确标成“需要重新登录”，而不是继续拿死 token 打请求。
   */
  const renewCredentialViaPage = async (
    current: StoredAuth,
    signal?: AbortSignal,
  ): Promise<StoredAuth | undefined> => {
    try {
      const renewed = await renewTransportPageCredential(
        current.auth.token,
        AUTH_RENEW_TIMEOUT_MS,
        signal,
      )
      if (!renewed?.token || renewed.token === current.auth.token) return undefined
      const next: StoredAuth = {
        ...current,
        account: {
          ...current.account,
          ...(renewed.displayName ? { displayName: renewed.displayName } : {}),
        },
        auth: {
          ...current.auth,
          token: renewed.token,
          ...(renewed.cookie ? { cookie: renewed.cookie } : {}),
        },
        ...(renewed.userId ? { userId: renewed.userId } : {}),
        savedAt: Date.now(),
      }
      saveAuth(next)
      // 站点自己换出了新 token：页面已是新凭证，标记可信并尽量对齐安装签名，
      // 免得恢复请求再触发一次“安装 + 重载页面”（那是第二次页面加载）。
      pageCredentialTrusted = true
      try {
        const sameHifLeim = String(renewed.hifLeim ?? '') === String(next.auth.hifLeim ?? '')
        if (sameHifLeim) {
          const writes = pageSessionFromHeaders({
            authorization: `Bearer ${next.auth.token}`,
            ...(next.auth.hifLeim ? { 'x-hif-leim': next.auth.hifLeim } : {}),
          })
          if (writes.length > 0) noteTransportPageSessionSignature(JSON.stringify(writes))
        }
      } catch {
        // 对齐失败只会多一次重载
      }
      logger?.info?.('freetoken: renewed the credential by reloading the transport page (no account switch)')
      try {
        deps.onAuthRefreshed?.(next)
      } catch {
        // 观测失败不影响重试
      }
      return next
    } catch (error: any) {
      logger?.warn?.(`freetoken: page-side credential renewal failed: ${error?.message ?? error}`)
      return undefined
    }
  }

  const start = async (signal?: AbortSignal): Promise<void> => {
    if (started) return
    if (config.backend === 'dom') {
      throw new FreetokenError('BACKEND_NOT_READY', 'freetoken: DOM backend is a planned option; v1 implements cdp only')
    }
    signal?.throwIfAborted()
    // R14：没有真实浏览器就没有 PoW / 传输；明确失败，绝不降级到宿主 Node 网络栈。
    if (!browserAvailable()) {
      throw new FreetokenError(
        'POW_REQUIRES_BROWSER',
        'freetoken: no Edge/Chrome found; PoW and transport require the real browser page (Node fallback disabled)',
      )
    }
    // 单实例锁先拿：一个账号一个浏览器实例（R13）。
    if (config.identity.singleInstance) releaseLock = acquireTransportLock('cdp')
    // 传输层页面的 UA 必须与登录捕获一致。headless 的默认 UA 带 `HeadlessChrome`，
    // 与请求指纹/站点风控预期不一致（账号库 shim 让 vendor 的 UA 传递静默失效）。
    setTransportUserAgent(readAuth()?.auth?.userAgent)
    // S1.1：投喂模式必须在第一次真实请求前落到 vendor 的运行时开关上。
    // vendor 内部一律以 `currentContextMode()` 为准（池/链/轮换判据都读它），
    // 只写配置不写这里等于没生效。
    //
    // ⚠️ 优先级（P2-2）：**落盘设置优先于配置**。
    // vendor 提供了 `readContextModeSetting()`（设置页保存的用户的显式选择），
    // 但它从没被调用过 ⇒ 配置会静默覆盖用户在面板上的选择。
    // 语义：用户在面板选过 ⇒ 以面板为准；没选过 ⇒ 用配置（默认 chained）。
    try {
      const persisted = readContextModeSetting()
      const effective = persisted ?? config.session.contextMode
      applyContextMode(effective)
      logger?.info?.(
        effective === 'chained'
          ? `freetoken: context feed = chained（只发增量；链式下不轮换会话，一个 DSH 会话长期对应同一网页会话）${
              persisted ? ' [来自设置页]' : ' [来自配置]'
            }`
          : `freetoken: context feed = full（每轮全量重发，按 reuseTurns 轮换）${
              persisted ? ' [来自设置页]' : ' [来自配置]'
            }`,
      )
    } catch (error: any) {
      logger?.warn?.(`freetoken: applying context mode failed: ${error?.message ?? error}`)
    }
    installBrowserEgress()
    cleaner = createCleaner()
    // 上次强杀留下的“欠删除”账本：启动时补扫（keep 模式内部为 no-op）。
    try {
      const scheduled = cleaner.sweepStartup()
      if (scheduled > 0) logger?.info?.(`freetoken: startup sweep re-queued ${scheduled} leaked web session(s) for deletion`)
    } catch (error: any) {
      logger?.warn?.(`freetoken: startup sweep failed: ${error?.message ?? error}`)
    }
    // 会话生命周期 → 落盘账本（M10）：进入复用槽即欠一次删除；确认删掉/放弃才销账。
    try {
      setSessionLifecycleHook((event) => {
        try {
          if (event.kind === 'leased' || event.kind === 'queued') {
            upsertJournalEntry({
              accountId: 'default',
              sessionId: event.sessionId,
              state: event.kind === 'queued' ? 'queued' : 'slot',
            })
          } else if (event.kind === 'deleted' || event.kind === 'abandoned') {
            removeJournalEntry(event.sessionId)
          }
        } catch (error: any) {
          logger?.warn?.(`freetoken: journal update failed: ${error?.message ?? error}`)
        }
      })
    } catch (error: any) {
      logger?.warn?.(`freetoken: session lifecycle hook unavailable: ${error?.message ?? error}`)
    }

    // S2.3/S2.4/S2.5：起常驻守护（页面活着 ⇒ 站点自己的 JS 就会维持会话；
    // 浏览器被误关 ⇒ 自动重新拉起；页面被导航走/丢登录态 ⇒ 本地自愈）。
    try {
      keepAlive ??= createTransportKeepAlive({
        probe: readTransportPageState,
        browserAvailable,
        ensureStarted: async () => {
          await launchTransportForKeepAlive()
        },
        navigateToSite: navigateTransportToSite,
        markPageSessionStale: markTransportPageSessionStale,
        invalidateSession: invalidateTransportSession,
        requestsInFlight: transportRequestsInFlight,
        onState: (state) => {
          try {
            deps.onStatus?.({
              session: {
                contextMode: config.session.contextMode,
                persistent: config.session.contextMode === 'chained',
                keepAliveState: state.state,
                keepAliveRestarts: state.restarts,
              },
              // P2-1：浏览器实际状态必须跟着守护走，否则面板会显示 "running"
              // 而浏览器其实已经死了（或已经被重启）—— 面板说谎比不显示更糟。
              browser: { running: state.state !== 'dead', pid: null },
            })
          } catch {
            // 观测失败不影响守护
          }
        },
        ...(logger ? { logger } : {}),
      })
      keepAlive.start()
    } catch (error: any) {
      logger?.warn?.(`freetoken: keep-alive unavailable: ${error?.message ?? error}`)
    }

    started = true
  }

  const requireAuth = (): StoredAuth => {
    const auth = readAuth()
    if (!auth?.auth?.token) {
      throw new FreetokenError('MISSING_CREDENTIAL', 'freetoken: not logged in; run `/freetoken login` first')
    }
    return auth
  }

  /**
   * 常驻守护专用：只把浏览器拉起来（不做业务请求、不动锁/清理器）。
   *
   * 与 `start()` 的区别：守护是在"浏览器被误关"时恢复**会话载体**，
   * 不该去重新获取单实例锁、也不该重复注册会话钩子（那些是一次性的）。
   */
  const launchTransportForKeepAlive = async (): Promise<void> => {
    if (!browserAvailable()) throw new Error('freetoken: no Edge/Chrome found for keep-alive')
    setTransportUserAgent(readAuth()?.auth?.userAgent)
    await launchBrowserTransport()
  }

  return {
    kind: config.backend,

    async start(signal?: AbortSignal) {
      await start(signal)
    },

    async *stream(request: BackendRequest) {
      await start(request.signal)
      // 请求前先把页面上的最新凭证同步进快照（页面优先，避免旧 token 覆盖新 token）。
      // 刚登录时页面还可能是旧凭证 ⇒ 不可信期间跳过采纳，等新凭证跑完一轮再恢复。
      const initial = requireAuth()
      renewalTriedThisTurn = false

      // S1.3 凭证年龄预检：快到期就先续签，别等任务跑到一半撞 401。
      //
      // 三重门（P0-1）：① 阈值命中；② 不在冷却期（上次续签失败后 10 分钟不再试）；
      // ③ 预检真的失败 ⇒ 进冷却。没有 ②③ 的话 `savedAt` 不更新会让 due 永久为真，
      // 变成"每个请求前整页重载一次"。
      const ageVerdict = evaluateCredentialAge({
        savedAt: initial.savedAt,
        now: Date.now(),
        thresholdMs: config.session.credentialRefreshAgeMs,
      })
      if (ageVerdict === 'due' && Date.now() >= preflightCooldownUntil) {
        renewalTriedThisTurn = true
        const age = Date.now() - initial.savedAt
        logger?.info?.(`freetoken: credential pre-flight refresh (${describeCredentialAge(age)})`)
        const preflight = await renewCredentialViaPage(initial, request.signal)
        if (preflight) {
          logger?.info?.('freetoken: pre-flight refresh renewed the credential before sending')
        } else {
          // 续不上就照旧发一次（真失效会由 AUTH 路径明确上报），但**进冷却**，
          // 避免下一个请求又整页重载一次。
          const cooldown = preflightCooldownMs(config.session.credentialRefreshAgeMs)
          preflightCooldownUntil = Date.now() + cooldown
          logger?.warn?.(
            `freetoken: pre-flight refresh failed; sending with the current credential and cooling down for ${Math.round(cooldown / 60_000)}min`,
          )
        }
      }

      const synced = pageCredentialTrusted ? await syncCredentialFromPage(initial) : undefined
      let currentAuth = toWebAuthShape(synced ?? initial)

      const params: any = {
        prompt: request.prompt,
        ...(request.promptParts ? { promptParts: request.promptParts } : {}),
        thinkingEnabled: request.thinkingEnabled === true,
        modelType: request.modelType ?? 'default',
        ...(request.refFileIds && request.refFileIds.length > 0 ? { refFileIds: request.refFileIds } : {}),
        ...(request.refKeys && request.refKeys.length > 0 ? { refKeys: request.refKeys } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.idleTimeoutMs ? { idleTimeoutMs: request.idleTimeoutMs } : {}),
        ...(request.connectTimeoutMs ? { connectTimeoutMs: request.connectTimeoutMs } : {}),
        sessionReuseTurns: config.session.reuseTurns,
        ...(request.sessionId ? { dshSessionId: request.sessionId } : {}),
        onContextFeed: (report: any) => {
          try {
            logger?.debug?.(
              report?.reason === 'chained'
                ? `freetoken: context=chained (+${report?.promptChars ?? '?'} chars)`
                : `freetoken: context=full (${report?.reason ?? 'unknown'})`,
            )
          } catch {
            // 观测失败不影响请求
          }
        },
        // 会话回收：交给带 journal 的 deferred 清理器（M10）。
        onDeleteSession: (sessionId: string) => {
          try {
            cleaner?.schedule('default', sessionId)
          } catch (error: any) {
            logger?.warn?.(`freetoken: schedule session cleanup failed: ${error?.message ?? error}`)
          }
        },
        onDiscardSession: (sessionId: string) => {
          void cleaner?.discard('default', sessionId).catch((error: any) => {
            logger?.warn?.(`freetoken: discard scaffold session failed: ${error?.message ?? error}`)
          })
        },
      }

      let contentEmitted = false
      let anyEmitted = false
      for (let attempt = 0; ; attempt += 1) {
        try {
          for await (const event of streamWebCompletion(currentAuth, params)) {
            // vendor 把 AUTH 作为 error 事件 yield（不是 throw）；在这里转成可分类错误，
            // 让下面的“页面续签后重试一次”能生效。
            if (event?.kind === 'error' && String(event?.code) === 'AUTH' && !anyEmitted) {
              const authError: any = new Error(String(event?.message ?? 'AUTH'))
              authError.code = 'AUTH'
              authError.retryable = false
              throw authError
            }
            anyEmitted = true
            if (event?.kind === 'text' || event?.kind === 'thinking') contentEmitted = true
            yield event
          }
          // 成功收尾：本轮用的是新凭证 ⇒ 页面已可信，把页面此刻的 token/cookie/身份回写 auth.json。
          // （网页端会轮换；不回收就会在一段时间后突然 AUTH invalid token。）
          pageCredentialTrusted = true
          const latest = readAuth()
          if (latest?.auth?.token) await syncCredentialFromPage(latest)
          return
        } catch (error: any) {
          const code = String(error?.code ?? '')
          // AUTH 只做一次“页面续签后重试”，且必须是本轮流尚未产出任何正文/思考内容时。
          //
          // 🔴 P0-1 的完整修法（复核指出）：冷却门必须**同时**管住 AUTH 恢复路径。
          // 否则预检失败 → `savedAt` 不更新 → `due` 永久为真，而 AUTH 恢复路径每轮都
          // 重置 `renewalTriedThisTurn` 且不受冷却约束 ⇒ 每个请求仍会整页 reload 一次
          // （"每请求整页重载"只是从预检挪到了 AUTH 路径，没有真正消除）。
          if (
            code === 'AUTH' &&
            !renewalTriedThisTurn &&
            Date.now() >= preflightCooldownUntil &&
            canAttemptAuthRecovery({ attempt, contentEmitted })
          ) {
            renewalTriedThisTurn = true
            const source = readAuth()
            if (source?.auth?.token) {
              const adopted = pageCredentialTrusted ? await syncCredentialFromPage(source) : undefined
              const renewed =
                adopted && adopted.auth.token !== source.auth.token
                  ? adopted
                  : await renewCredentialViaPage(source, request.signal)
              if (renewed) {
                currentAuth = toWebAuthShape(renewed)
                continue
              }
              // 续签失败 ⇒ 同样进冷却：否则下一个请求又会整页重载一次。
              preflightCooldownUntil = Date.now() + preflightCooldownMs(config.session.credentialRefreshAgeMs)
            }
          }
          if (code === 'AUTH') {
            const message =
              'freetoken: 网页登录态已过期或无效（AUTH）；已尝试从传输层页面自动续签仍失败，' +
              '请运行 `/freetoken login` 重新登录（现有凭证不会被清除）。'
            try {
              deps.onAuthFailed?.(message)
            } catch {
              // 观测失败不改变错误语义
            }
          }
          throw error
        }
      }
    },

    async uploadImage(input: UploadImageInput): Promise<{ fileId: string }> {
      await start()
      const current = requireAuth()
      const synced = pageCredentialTrusted ? await syncCredentialFromPage(current) : undefined
      const auth = synced ?? current
      const bytes =
        typeof input.data === 'string' ? Uint8Array.from(Buffer.from(input.data, 'base64')) : input.data
      const uploaded = await uploadImageFile(toWebAuthShape(auth), {
        data: bytes,
        mediaType: input.mediaType ?? 'image/png',
        ...(input.name ? { name: input.name } : {}),
      })
      return { fileId: uploaded.fileId }
    },

    async probe(auth: StoredAuth) {
      await start()
      // 探活也是网页请求：同样走页面内 fetch（零额度）。
      // 先同步页面上的最新凭证，避免“页面已轮换、探活还拿旧 token → 假 401 → 面板误报未登录”。
      const synced = pageCredentialTrusted ? await syncCredentialFromPage(auth) : undefined
      void pageFetch
      return probeViaEgress(synced ?? auth)
    },

    resetCredentialSession() {
      // 新凭证：页面上的旧登录态必须整体作废。
      // ① 立刻标记“页面凭证不可信”：在它被新凭证重装前，请求前同步不得把旧 token 采纳回来。
      // ② 有在飞请求时**不要**立刻杀浏览器（会掐断流、并让登录探活一起卡住）；
      //    注册一次性 idle 钩子，等在飞归零再回收。
      pageCredentialTrusted = false
      try {
        setTransportUserAgent(readAuth()?.auth?.userAgent)
      } catch {
        // 观测失败不影响登录结果
      }
      const recycle = (): void => {
        try {
          invalidateTransportSession()
        } catch {
          // 会话本来就不存在
        }
      }
      try {
        if (transportRequestsInFlight() > 0) {
          setTransportIdleHook(recycle)
          logger?.info?.(
            `freetoken: credential reset deferred until ${transportRequestsInFlight()} in-flight request(s) settle`,
          )
          return
        }
      } catch {
        // 查询失败就按“可立刻回收”处理
      }
      recycle()
    },

    async close() {
      // 收尾：先停守护（否则关浏览器时它会把浏览器又拉起来），再刷账本、关浏览器。
      try {
        keepAlive?.stop()
      } catch {
        // 忽略
      }
      keepAlive = undefined
      try {
        setTransportIdleHook(undefined)
      } catch {
        // 忽略
      }
      try {
        await cleaner?.flush()
      } catch {
        // flush 失败保留账本
      }
      try {
        setSessionLifecycleHook(undefined)
      } catch {
        // 忽略
      }
      cleaner?.dispose()
      cleaner = undefined
      try {
        await closeEgress()
      } catch {
        // 关闭失败留给下次启动清理
      }
      releaseLock?.()
      releaseLock = undefined
      started = false
    },
  }
}