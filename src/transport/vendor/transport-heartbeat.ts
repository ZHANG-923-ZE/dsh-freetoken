// @ts-nocheck (vendored from cv-superding/dsh-deepseek-web-login@cfd684d; see vendor/NOTICE.md)
/**
 * 传输层保活心跳 —— "那个页面还活着吗、还登着吗"。
 *
 * ## 为什么需要
 *
 * 传输层浏览器是**常驻**的（没有空闲关闭），因为页面只要停在站点 origin 上，
 * 站点自己的 JS 就会跑、就会产生它自己的会话轮询 —— 那才是"真人"的成分。
 * 反过来，一旦页面被导航走 / 登录态被清 / 浏览器挂了，下一次请求就会以
 * **页面其实未登录、而请求带着合法 Bearer** 的形态发出去 —— 真人身上不会出现的组合。
 * 这个模块就是盯这件事，并在坏掉时**修**，而不是等下一次请求自己去撞。
 *
 * ## 🔴 为什么不给站点发定时 ping
 *
 * 固定周期本身就是模式（2026-10-14 结论）。站点的心跳该由**页面里站点自己的 JS** 产生，
 * 我们只保证那个页面活着即可。所以本模块：
 *   - 只做**本地探测**（CDP `Runtime.evaluate` 读 location / localStorage）—— **零网络请求**；
 *   - 间隔**带抖动**（不是固定周期）；
 *   - **只在传输层已经在用时才跑** —— 绝不为了"心跳"去新建一个浏览器会话（那等于凭空造活动）。
 *
 * ## 恢复动作都走已有的、被测过的路径
 *
 *   - `logged-out` ⇒ 把页面登录态槽的**签名作废**，让下一次请求按既有流程重装
 *     （凭据来自那次请求自己，不需要在这里再去取账号）；
 *   - `off-origin` ⇒ 导航回站点 origin；
 *   - `dead`     ⇒ 标记会话失效，下一次请求重新拉起（既有行为）。
 * 这三件都不制造流量。
 */

export type HeartbeatState = 'idle' | 'alive' | 'logged-out' | 'off-origin' | 'dead'

/** 一次探测读回来的页面状态（都是页面内本地值）。 */
export interface PageObservation {
  url: string
  readyState: string
  /** `localStorage.userToken` 的**解包后**值；空串表示页面自认未登录。 */
  userToken: string
  /** `localStorage.__appKit_userInfo` 里的账号 id（站点写入了才有；用于稳定账号身份）。 */
  userId?: string
  /** 同上，账号展示名。 */
  displayName?: string
  /** `localStorage.hif_leim_cached` 的解包值（用于判断页面与快照的登录态是否同一份）。 */
  hifLeim?: string
}

export interface HeartbeatSnapshot {
  state: HeartbeatState
  /** 最后一次探测的时刻（ms） */
  at: number
  /** 探测次数 */
  beats: number
  /** 真正做过恢复动作的次数 */
  recoveries: number
  /** 连续失败（dead）次数 —— 连续太多次就停表，别空转 */
  consecutiveFailures: number
  /** 最近一次状态变化的说明（给 /status 与面板看） */
  lastReason?: string
}

/**
 * 判定当前状态。`observed` 为 `null` 表示**探测本身失败**（浏览器不在了 / CDP 断了）。
 */
export function judgeObservation(
  observed: PageObservation | null,
  origin: string,
): { state: HeartbeatState; reason?: string } {
  if (!observed) return { state: 'dead', reason: '探测不到页面（浏览器可能已退出）' }
  const url = String(observed.url ?? '')
  /**
   * ⚠️ 必须连**域名边界**一起比：`startsWith(origin)` 会把
   * `https://chat.deepseek.com.evil.com/` 判成"在站点上"（前缀相同）。
   * 站点 origin 后面只允许是 `/`（或就是 origin 本身）。
   */
  if (url !== origin && !url.startsWith(`${origin}/`)) {
    return { state: 'off-origin', reason: `页面已不在站点 origin：${url.slice(0, 120)}` }
  }
  if (!String(observed.userToken ?? '').trim()) {
    return { state: 'logged-out', reason: '页面里没有登录态（站点自己的 JS 会以为未登录）' }
  }
  return { state: 'alive' }
}

/**
 * 下一次探测的间隔：`base * [0.6, 1.4]`。
 *
 * 🔴 抖动是**故意的**：固定周期是最容易识别的模式之一；而且抖动也让多窗口之间不至于同步。
 */
export function pickIntervalMs(baseMs: number, random: () => number = Math.random): number {
  if (!Number.isFinite(baseMs) || baseMs <= 0) throw new Error(`baseMs 非法：${baseMs}`)
  const factor = 0.6 + clamp01(random()) * 0.8
  return Math.max(1_000, Math.round(baseMs * factor))
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

export interface HeartbeatEffects {
  /** 本地探测；返回 null 表示探测失败（不要在这里抛）。 */
  probe: () => Promise<PageObservation | null>
  /** 页面未登录 ⇒ 作废登录态签名，让下一次请求重装。 */
  onLoggedOut: () => unknown
  /** 页面不在站点 origin ⇒ 导航回去。 */
  onOffOrigin: () => unknown
  /** 浏览器/会话不可用 ⇒ 标记失效，下一次请求重新拉起。 */
  onDead: () => unknown
}

export interface TransportHeartbeatOptions extends HeartbeatEffects {
  /** 心跳基准间隔（实际会抖动）。 */
  baseMs?: number
  /** 连续多少次探测失败后停表（默认 3）。 */
  stopAfterFailures?: number
  now?: () => number
  random?: () => number
  log?: (message: string) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface TransportHeartbeat {
  /** 幂等：已经在跑就不重复起表。 */
  start: () => void
  stop: () => void
  running: () => boolean
  /**
   * 传输层被真实使用过一次（已经拉起会话）⇒ 复位失败计数并起表。
   *
   * 为什么需要"复位"：连续探测不到会停表（别空转）；而下一次请求会重新拉起浏览器，
   * 那时失败计数就不再代表现实了 —— 不复位的话保活就再也起不来了。
   */
  noteTransportUsed: () => void
  /** 单次探测（用例直接调它，不依赖真定时器）。 */
  beatOnce: () => Promise<HeartbeatSnapshot>
  snapshot: () => HeartbeatSnapshot
}

const DEFAULT_BASE_MS = 60_000
const DEFAULT_STOP_AFTER = 3

export function createTransportHeartbeat(options: TransportHeartbeatOptions): TransportHeartbeat {
  const baseMs = options.baseMs ?? DEFAULT_BASE_MS
  const stopAfter = options.stopAfterFailures ?? DEFAULT_STOP_AFTER
  const now = options.now ?? (() => Date.now())
  const random = options.random ?? Math.random
  const log = options.log ?? (() => {})
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms)
      // 后台表：不因为它把宿主进程留在事件循环里
      if (handle && typeof (handle as { unref?: () => void }).unref === 'function') {
        ;(handle as { unref: () => void }).unref()
      }
      return handle
    })
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>)
    })

  let snapshot: HeartbeatSnapshot = {
    state: 'idle',
    at: 0,
    beats: 0,
    recoveries: 0,
    consecutiveFailures: 0,
  }
  let timer: unknown
  let inFlight = false

  function schedule(): void {
    if (timer !== undefined) return
    const ms = pickIntervalMs(baseMs, random)
    timer = setTimer(() => {
      timer = undefined
      void beatOnce().then(() => {
        if (snapshot.consecutiveFailures < stopAfter) schedule()
      })
    }, ms)
  }

  async function beatOnce(): Promise<HeartbeatSnapshot> {
    if (inFlight) return snapshot
    inFlight = true
    try {
      let observed: PageObservation | null = null
      try {
        observed = await options.probe()
      } catch (error: any) {
        observed = null
        log(`传输层心跳：探测抛错（按不可用处理）：${error?.message ?? error}`)
      }
      const judged = judgeObservation(observed, SITE_ORIGIN)
      const previous = snapshot.state
      snapshot = {
        ...snapshot,
        state: judged.state,
        at: now(),
        beats: snapshot.beats + 1,
        consecutiveFailures: judged.state === 'dead' ? snapshot.consecutiveFailures + 1 : 0,
        ...(judged.reason ? { lastReason: judged.reason } : {}),
      }
      // 只在**状态变化**时做恢复动作：状态没变说明上一次已经处理过，重复做只是空转
      if (judged.state !== previous) {
        await recover(judged.state)
      }
      return snapshot
    } finally {
      inFlight = false
    }
  }

  async function recover(state: HeartbeatState): Promise<void> {
    try {
      if (state === 'logged-out') {
        await options.onLoggedOut()
        log('传输层心跳：页面未登录 ⇒ 作废登录态签名，下次请求会重装')
      } else if (state === 'off-origin') {
        await options.onOffOrigin()
        log('传输层心跳：页面被导航走了 ⇒ 导航回站点 origin')
      } else if (state === 'dead') {
        await options.onDead()
        log(
          snapshot.consecutiveFailures >= stopAfter
            ? `传输层心跳：连续 ${snapshot.consecutiveFailures} 次探测不到页面 ⇒ 停表（下次请求会重新拉起）`
            : '传输层心跳：探测不到页面 ⇒ 标记会话失效（下次请求会重新拉起）',
        )
      } else {
        return
      }
      snapshot = { ...snapshot, recoveries: snapshot.recoveries + 1 }
    } catch (error: any) {
      // 恢复动作失败不能把心跳打挂：记下来、继续跑（下一次状态没变就不会再试）
      snapshot = {
        ...snapshot,
        lastReason: `恢复动作失败（${state}）：${error?.message ?? error}`,
      }
      log(`传输层心跳：恢复动作失败：${error?.message ?? error}`)
    }
  }

  return {
    start() {
      // 已经是"死了很多次"的状态就别再起：等下一次真实请求把传输层拉起来再说
      if (timer !== undefined || inFlight) return
      if (snapshot.consecutiveFailures >= stopAfter) return
      schedule()
    },
    stop() {
      if (timer === undefined) return
      clearTimer(timer)
      timer = undefined
    },
    running: () => timer !== undefined,
    noteTransportUsed() {
      if (snapshot.consecutiveFailures !== 0) {
        snapshot = { ...snapshot, consecutiveFailures: 0 }
      }
      if (timer === undefined && !inFlight) schedule()
    },
    beatOnce,
    snapshot: () => ({ ...snapshot }),
  }
}

/**
 * 站点 origin 与传输层模块保持一致（那边是唯一权威，这里引用是为了不hardcode两处）。
 * 用 `require` 式的延迟引用会让纯逻辑模块也能被独立单测 —— 所以这里直接写常量并在
 * `check-transport-heartbeat` 里断言它与 `TRANSPORT_SITE_ORIGIN` 相等。
 */
export const SITE_ORIGIN = 'https://chat.deepseek.com'

