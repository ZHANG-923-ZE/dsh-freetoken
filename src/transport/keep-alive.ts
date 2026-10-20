/**
 * 传输层常驻守护（S2.3 / S2.4 / S2.5，2026-10-20 会话所有权）。
 *
 * ## 为什么需要
 *
 * 旧实现里传输层浏览器是"用完即弃"的：只在请求时才懒启动，插件卸载才关闭。
 * 但站点维持登录态靠的是**页面自己的 JS 一直在跑**（轮询、活动），页面没了、
 * 会话就慢慢死。用户诉求是"后台网页版登录一直在"。
 *
 * 本模块做三件事，全部是**本地动作**（不新增任何出网请求）：
 *
 * 1. **常驻**：启用后有凭证就起传输层，之后不因空闲关闭；
 * 2. **守护**：定时检查浏览器还活着（本地 CDP 探测），被发现死了就重新拉起；
 * 3. **自愈**：接 `createTransportHeartbeat` 的四态判据 —— 页面被导航走就导航回站点，
 *    页面丢了登录态就作废安装签名让下一次请求重装，浏览器不可用就标记失效。
 *
 * 红线：`RhythmController` 仍是唯一出网闸门；这里只做 CDP 本地探测，且**间隔带抖动**
 * （固定周期本身就是一种模式，基座在 `transport-heartbeat.ts` 里已经论证过）。
 *
 * 时间/定时器全部可注入，离线用例不依赖真实定时器。
 */

import type { PageObservation } from './vendor/transport-heartbeat.ts'
import { SITE_ORIGIN } from './credential.ts'

export interface KeepAliveDeps {
  /** 本地探测页面状态（不发网络）。返回 null=探测失败。 */
  probe: () => Promise<PageObservation | null>
  /** 浏览器是否可用（用于判断"该不该起"）。 */
  browserAvailable: () => boolean
  /** 确保传输层已启动（幂等；失败应 throw）。 */
  ensureStarted: () => Promise<void>
  /** 页面被导航走：导航回站点 origin。 */
  navigateToSite: () => Promise<boolean>
  /** 页面丢了登录态：作废安装签名，下次请求重装。 */
  markPageSessionStale: () => void
  /** 浏览器不可用：标记会话失效，下次请求重新拉起。 */
  invalidateSession: () => void
  /**
   * 当前在飞请求数。**必填**：有请求在飞时绝不能杀浏览器（会掐断流）。
   * 见 `browser-transport.ts` 的 `transportRequestsInFlight`。
   */
  requestsInFlight: () => number
  /** 状态变化回调（面板/status 消费）。 */
  onState?: (snapshot: KeepAliveSnapshot) => void
  logger?: { info?: (message: string) => void; warn?: (message: string) => void }
  now?: () => number
  random?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** 守护间隔（实际会抖动 ×[0.7,1.3]）。 */
  intervalMs?: number
  /** 连续多少次探测失败才判定"死了"（避免一次抖动就重启浏览器）。 */
  stopAfterFailures?: number
}

export type KeepAliveState = 'idle' | 'alive' | 'logged-out' | 'off-origin' | 'dead'

export interface KeepAliveSnapshot {
  state: KeepAliveState
  beats: number
  restarts: number
  consecutiveFailures: number
  lastReason?: string
  /** 最近一次巡检时刻（ms）。 */
  lastBeatAt?: number
}

export interface KeepAlive {
  start(): void
  stop(): void
  running(): boolean
  /** 单次巡检（用例直接调它，不依赖真实定时器）。 */
  beatOnce(): Promise<KeepAliveSnapshot>
  snapshot(): KeepAliveSnapshot
}

export const DEFAULT_KEEPALIVE_INTERVAL_MS = 60_000
const DEFAULT_STOP_AFTER = 3

/**
 * 判定一次探测的结论（纯函数，可反测）。
 *
 * 与 `judgeObservation` 同一套语义，但这里额外把"页面已登录"与"页面在站点上"
 * 分开处理：它们在恢复动作上完全不同（前者作废签名、后者导航回去）。
 */
export function judgeKeepAlive(
  observed: PageObservation | null,
  origin: string,
  consecutiveFailures: number,
  stopAfterFailures: number,
): { state: KeepAliveState; reason?: string; fatal: boolean } {
  if (!observed) {
    const failures = consecutiveFailures + 1
    if (failures >= stopAfterFailures) {
      return { state: 'dead', reason: '连续探测不到页面（浏览器可能已退出）', fatal: true }
    }
    return { state: 'dead', reason: `探测失败 ${failures}/${stopAfterFailures}`, fatal: false }
  }
  const url = String(observed.url ?? '')
  if (url !== origin && !url.startsWith(`${origin}/`)) {
    return { state: 'off-origin', reason: `页面已不在站点 origin：${url.slice(0, 120)}`, fatal: false }
  }
  if (!String(observed.userToken ?? '').trim()) {
    return { state: 'logged-out', reason: '页面里没有登录态（站点 JS 会以为未登录）', fatal: false }
  }
  return { state: 'alive', fatal: false }
}

/** 下一次巡检间隔：`base × [0.7, 1.3]`，故意抖动（固定周期是模式）。 */
export function jitterInterval(baseMs: number, random: () => number = Math.random): number {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : DEFAULT_KEEPALIVE_INTERVAL_MS
  const factor = 0.7 + Math.max(0, Math.min(1, random())) * 0.6
  return Math.max(1_000, Math.round(base * factor))
}

export function createTransportKeepAlive(deps: KeepAliveDeps): KeepAlive {
  const intervalMs = deps.intervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS
  const stopAfter = deps.stopAfterFailures ?? DEFAULT_STOP_AFTER
  const now = deps.now ?? (() => Date.now())
  const random = deps.random ?? Math.random
  const log = deps.logger ?? {}
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms)
      if (handle && typeof (handle as { unref?: () => void }).unref === 'function') {
        ;(handle as { unref: () => void }).unref()
      }
      return handle
    })
  const clearTimer =
    deps.clearTimer ??
    ((handle: unknown) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>)
    })

  let snapshot: KeepAliveSnapshot = {
    state: 'idle',
    beats: 0,
    restarts: 0,
    consecutiveFailures: 0,
  }
  let timer: unknown
  let inFlight = false
  let stopped = false
  /** 上一次判定的状态：恢复动作只在**状态变化**时做（与 vendor heartbeat 同一纪律）。 */
  let previousState: KeepAliveState = 'idle'
  /** 上一次是否已"真死"：连续失败是从非致命升级到致命，状态字段不变但动作必须触发。 */
  let previousFatal = false
  /** 重启退避截止时刻：失败后指数退避，避免每分钟 spawn 一次刷屏。 */
  let restartBackoffUntil = 0
  /** 连续重启失败次数（用于指数退避与最终停表）。 */
  let restartFailures = 0

  // 站点 origin 只有一处权威（`credential.ts` 的 `SITE_ORIGIN`），避免多处硬编码漂移。
  const origin = SITE_ORIGIN
  /** 同一 off-origin 连续导航次数上限：反复失败就只告警，不再每拍整页加载。 */
  let navigateAttempts = 0
  /** 最近一次巡检完成时刻（给面板看）。 */
  let lastBeatAt = 0

  /** 上报状态（失败不影响巡检）。 */
  function report(): void {
    try {
      deps.onState?.(snapshot)
    } catch {
      // 观测失败不影响守护
    }
  }

  function schedule(): void {
    if (stopped || timer !== undefined) return
    const ms = jitterInterval(intervalMs, random)
    timer = setTimer(() => {
      timer = undefined
      void beatOnce().then(() => {
        if (!stopped) schedule()
      })
    }, ms)
  }

  async function beatOnce(): Promise<KeepAliveSnapshot> {
    if (inFlight) return snapshot
    inFlight = true
    try {
      if (!deps.browserAvailable()) {
        snapshot = {
          ...snapshot,
          state: 'dead',
          consecutiveFailures: snapshot.consecutiveFailures + 1,
          lastReason: '本机没有可用浏览器',
        }
        return snapshot
      }

      // 重启退避期内不做任何动作（否则失败一次就每分钟 spawn+25s 等待，日志刷屏）。
      if (now() < restartBackoffUntil) {
        snapshot = { ...snapshot, lastReason: '重启退避中' }
        return snapshot
      }

      let observed: PageObservation | null = null
      try {
        observed = await deps.probe()
      } catch (error: any) {
        observed = null
        log.warn?.(`freetoken: keep-alive probe threw: ${error?.message ?? error}`)
      }

      const judged = judgeKeepAlive(observed, origin, snapshot.consecutiveFailures, stopAfter)
      // 注意：连续失败时 state 一直是 'dead'，但"升级到致命"（fatal）必须触发动作。
      const changed = judged.state !== previousState || (judged.fatal && !previousFatal)
      previousState = judged.state
      snapshot = {
        ...snapshot,
        state: judged.state,
        beats: snapshot.beats + 1,
        consecutiveFailures:
          judged.state === 'dead' ? snapshot.consecutiveFailures + 1 : 0,
        ...(judged.reason ? { lastReason: judged.reason } : {}),
      }

      /**
       * 🔴 有在飞请求时**绝不**杀浏览器（P0-2）—— 这个判据必须放在"状态变化"门**之前**：
       * 连续失败时 state 一直是 'dead'，若先过 changed 门就会在第二次起直接 return，
       * 于是面板说明被覆盖成普通原因，而真正的动作（重启）又被推迟到"状态再变化"，
       * 可能出现"永远等不到重启"。
       *
       * `invalidateSession()` 会 taskkill 整棵进程树 + 关 CDP，正在流式输出的请求
       * 会立刻失去通道 —— 用户看到的就是"任务跑到一半断了"。
       * 与 `resetCredentialSession()` 同一条纪律：等请求跑完再动。
       */
      if (judged.state === 'dead' && judged.fatal && deps.requestsInFlight() > 0) {
        // 复位致命标记：等请求跑完后**下一次**巡检要能重新触发重启。
        previousFatal = false
        snapshot = {
          ...snapshot,
          lastReason: `探测到浏览器不可用，但仍有 ${deps.requestsInFlight()} 个请求在飞 ⇒ 暂不重启`,
        }
        report()
        return snapshot
      }

      previousFatal = judged.fatal

      /**
       * 🔴 恢复动作只在**状态变化**时做（P1-1）。
       *
       * 每拍都做会造成：① 每次探测都整页 `Page.navigate`（那是**网络流量**，
       * 违反"心跳只做本地 CDP 探测"的红线）；② 与"探测失败→判死→杀浏览器"
       * 形成正反馈。vendor 的 `transport-heartbeat` 就是这个纪律，这里必须一致。
       */
      if (!changed) {
        report()
        return snapshot
      }

      if (judged.state === 'off-origin') {
        // 页面被导航走了：拉回站点（本地动作，但会触发一次整页加载 ⇒ 必须限次）。
        if (navigateAttempts < 2) {
          navigateAttempts += 1
          const ok = await deps.navigateToSite().catch(() => false)
          if (ok) log.info?.('freetoken: keep-alive navigated the page back to the site origin')
        } else {
          log.warn?.('freetoken: keep-alive off-origin persists; not navigating again this round')
        }
      } else if (judged.state === 'logged-out') {
        // 页面丢了登录态：作废签名 → 下一次请求会把快照里的凭证重新装进页面。
        deps.markPageSessionStale()
        navigateAttempts = 0
      } else if (judged.state === 'dead' && judged.fatal) {
        // 探测期间被 stop()（插件卸载/关闭）：不得再拉起浏览器，否则会留下孤儿进程占住 profile。
        if (stopped) {
          snapshot = { ...snapshot, lastReason: '守护已停止 ⇒ 不再重启浏览器' }
          return snapshot
        }
        try {
          deps.invalidateSession()
          await deps.ensureStarted()
          // 启动期间被 stop() 打断：收掉刚起的东西，避免留下孤儿浏览器占住 profile。
          if (stopped) {
            deps.invalidateSession()
            return snapshot
          }
          snapshot = {
            ...snapshot,
            restarts: snapshot.restarts + 1,
            consecutiveFailures: 0,
            state: 'idle',
            lastReason: '浏览器不可用 ⇒ 已重新拉起',
          }
          restartFailures = 0
          restartBackoffUntil = 0
          previousState = 'idle'
          previousFatal = false
          log.info?.('freetoken: keep-alive restarted the transport browser')
        } catch (error: any) {
          restartFailures += 1
          const backoffMs = Math.min(30 * 60_000, 60_000 * 2 ** (restartFailures - 1))
          restartBackoffUntil = now() + backoffMs
          /**
           * 🔴 必须复位致命标记（否则浏览器**永远**不会被再次重启）。
           *
           * `changed` 的判据是「状态变化 **或** 从非致命升级到致命」。重启失败后
           * `previousFatal` 仍是 true ⇒ 退避期结束后那一拍 `changed` 为 false
           * ⇒ 直接 return ⇒ 再也不会重试。退避 + 复位两者缺一不可。
           */
          previousFatal = false
          log.warn?.(
            `freetoken: keep-alive restart failed (${restartFailures}x, next attempt in ${Math.round(backoffMs / 1000)}s): ${error?.message ?? error}`,
          )
          // 连续失败太多次就停表，等下一次真实请求/重新登录再 arm（不空转）。
          if (restartFailures >= 5) {
            log.warn?.('freetoken: keep-alive gave up restarting after 5 attempts; stopping the beat')
            stopped = true
            if (timer !== undefined) {
              clearTimer(timer)
              timer = undefined
            }
          }
        }
      } else if (judged.state === 'alive') {
        navigateAttempts = 0
      }
      report()
      return snapshot
    } finally {
      inFlight = false
      lastBeatAt = now()
    }
  }

  return {
    start() {
      // 允许 stop() 之后重新 arm（例如重新登录后想恢复守护）。
      if (timer !== undefined || inFlight) return
      stopped = false
      schedule()
    },
    stop() {
      stopped = true
      if (timer !== undefined) {
        clearTimer(timer)
        timer = undefined
      }
    },
    running: () => timer !== undefined,
    beatOnce,
    snapshot: () => ({ ...snapshot, ...(lastBeatAt > 0 ? { lastBeatAt } : {}) }),
  }
}