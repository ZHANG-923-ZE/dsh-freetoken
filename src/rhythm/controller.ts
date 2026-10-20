/**
 * RhythmController：所有网页请求的唯一节奏出口（M11 / M14 / M15 / M21 / M22）。
 *
 * 这里只做“何时允许发 / 发完怎么冷却”的状态机，组合既有节奏原语：
 *   daily（日预算）→ queue（在飞上限）→ silence（动态静默）→ lock（全局串行）
 *   → jitter（发送前抖动）→ burst（每 turn 上限）→ sending。
 *
 * 设计边界：
 *  - 不持有网络 / 浏览器 / 协议能力，是纯节奏层；真正 fetch 在 transport/egress.ts。
 *  - 时间、随机源、sleep 全部可注入，离线用例不依赖真实定时器。
 *  - 状态通过 onStatus 回填，patch 一律 structuredClone 安全的纯对象（嵌套整体给出）。
 *  - burst 无法感知 DSH 的 turn 边界：以 [sessionId|purpose|kind] 作保守 turnKey
 *    （同会话同类请求共享上限）。超限只延长间隔，绝不丢弃调用（D15）。
 */

import type { FreetokenConfig } from '../config.js'
import { FreetokenError, type FreetokenErrorCode } from '../adapter/errors.js'
import type { LastBlock, LastFailure, RhythmPhase, StatusSnapshot } from '../status.js'
import { BurstTracker } from './burst.js'
import { DailyBudget } from './daily.js'
import { nextJitter } from './jitter.js'
import { SerialLock } from './lock.js'
import { PendingQueue } from './queue.js'
import { nextRetry } from './retry.js'
import { silenceDuration } from './silence.js'

export type RequestKind = 'chat' | 'compaction' | 'session-title' | 'internal'

export interface AcquireOptions {
  kind?: RequestKind
  purpose?: string
  sessionId?: string
  signal?: AbortSignal
}

export interface Lease {
  /** 真正发出网页请求时调用（计数 + 记录 lastRequestAt）。 */
  markSent(): void
  /** 结束本次请求：释放锁/队列，必要时开始静默；幂等。 */
  release(): void
  /** 记录失败；返回下一次退避毫秒数（0 = 不重试）。 */
  markFailure(code: string, message: string, retryable: boolean): number
  /** 记录成功：清零重试计数，回到 idle。 */
  markSuccess(): void
}

export interface RhythmSnapshot {
  phase: RhythmPhase
  silent: boolean
  silenceRemainingMs: number
  todayRequests: number
  lastRequestAt: number | null
  queuePending: number
  lockHeld: boolean
  lastBlock: LastBlock | null
  retry: { attempts: number; nextDelayMs: number }
  maxCallsPerTurn: number
  dailyBudget: number
}

export interface RhythmController {
  acquire(options?: AcquireOptions): Promise<Lease>
  snapshot(): RhythmSnapshot
  dispose(): void
}

export interface RhythmControllerDeps {
  config: FreetokenConfig
  now?: () => number
  random?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  onStatus?: (patch: Partial<StatusSnapshot>) => void
  onMetric?: (name: string, value?: number) => void
  /** 从磁盘恢复的今日已发数（跨重启累计）。 */
  initialTodayRequests?: number
}

/** burst 超限后的额外间隔区间（R/D15）：再叠一次 jitter + 30–60s。 */
export const BURST_GAP_MIN_MS = 30_000
export const BURST_GAP_MAX_MS = 60_000

/** 永不自动重试的失败码（AUTH / mute / QUOTA 等，与 retry.ts 的可重试集合互补）。 */
const NEVER_RETRY_CODES: ReadonlySet<string> = new Set([
  'AUTH',
  'MUTED',
  'MUTE',
  'ACCOUNT_MUTED',
  'QUOTA',
  'QUOTA_EXCEEDED',
  'PERMANENT',
])

function abortError(): Error {
  const error = new Error('freetoken: rhythm acquire aborted')
  error.name = 'AbortError'
  return error
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    function cleanup(): void {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    function onAbort(): void {
      cleanup()
      reject(abortError())
    }
    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, Math.max(0, Math.round(ms)))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** errors.ts 的联合类型尚未收录节奏码；运行时原样保留 code 供宿主分流。 */
function rhythmError(code: 'DAILY_BUDGET' | 'QUEUE_FULL', message: string): FreetokenError {
  return new FreetokenError(code as unknown as FreetokenErrorCode, message)
}

function normalizeCode(code: string): string {
  return typeof code === 'string' ? code.trim().toUpperCase() : ''
}

function isMuteCode(code: string): boolean {
  return normalizeCode(code).includes('MUT')
}

function isNeverRetryCode(code: string): boolean {
  return NEVER_RETRY_CODES.has(normalizeCode(code))
}

/**
 * 从失败消息里尽量推导 mute 解除时间（推导不出就返回 null，不猜测）。
 * 支持 ISO 时间、epoch 秒/毫秒、retry-after 秒数、中文时长。
 */
function deriveMutedUntil(message: string, now: number): number | null {
  if (typeof message !== 'string' || message.length === 0) return null
  const iso = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/i.exec(message)
  if (iso) {
    const parsed = Date.parse(iso[1] as string)
    if (Number.isFinite(parsed) && parsed > now) return parsed
  }
  // 真机格式：`2026/10/23 13:33:37 解除`（网页端 UI 文案直接带斜杠日期）
  const slash = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(message)
  if (slash) {
    const parsed = new Date(
      Number(slash[1]),
      Number(slash[2]) - 1,
      Number(slash[3]),
      Number(slash[4]),
      Number(slash[5]),
      Number(slash[6] ?? 0),
    ).getTime()
    if (Number.isFinite(parsed) && parsed > now) return parsed
  }
  const epoch = /(?:mutedUntil|muted_until|reset(?:At|_at)?)[^0-9]{0,8}(\d{10,13})/i.exec(message)
  if (epoch) {
    const raw = Number(epoch[1])
    const value = raw > 1_000_000_000_000 ? raw : raw * 1000
    if (Number.isFinite(value) && value > now) return value
  }
  const retryAfter = /retry[- ]?after[^0-9]{0,8}(\d+)/i.exec(message)
  if (retryAfter) {
    const seconds = Number(retryAfter[1])
    if (Number.isFinite(seconds) && seconds > 0) return now + seconds * 1000
  }
  const chinese = /(\d+)\s*(秒|分钟|小时)/.exec(message)
  if (chinese) {
    const amount = Number(chinese[1])
    const unit = chinese[2]
    const unitMs = unit === '小时' ? 3_600_000 : unit === '分钟' ? 60_000 : 1000
    if (Number.isFinite(amount) && amount > 0) return now + amount * unitMs
  }
  return null
}

function turnKeyOf(options: AcquireOptions): string {
  const parts = [options.sessionId, options.purpose, options.kind].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  )
  return parts.length > 0 ? parts.join('|') : 'default'
}

function describeRequest(options: AcquireOptions): string {
  const parts: string[] = []
  if (options.kind) parts.push(options.kind)
  if (options.purpose) parts.push(options.purpose)
  if (options.sessionId) parts.push(options.sessionId)
  return parts.length > 0 ? parts.join(':') : 'default'
}

export function createRhythmController(deps: RhythmControllerDeps): RhythmController {
  const config = deps.config
  const now = deps.now ?? (() => Date.now())
  const random = deps.random ?? (() => Math.random())
  const sleep = deps.sleep ?? defaultSleep
  const reportStatus: (patch: Partial<StatusSnapshot>) => void = deps.onStatus ?? (() => undefined)
  const reportMetric: (name: string, value?: number) => void = deps.onMetric ?? (() => undefined)

  const daily = new DailyBudget({
    budget: config.rhythm.dailyBudget,
    now,
    ...(deps.initialTodayRequests !== undefined ? { initialCount: deps.initialTodayRequests } : {}),
  })
  const queue = new PendingQueue({ maxPending: config.queue.maxPending })
  const lock = new SerialLock()
  const burst = new BurstTracker({ maxCalls: config.rhythm.maxCallsPerTurn })
  const lifetime = new AbortController()

  let disposed = false
  let phase: RhythmPhase = 'idle'
  let silenceUntil = 0
  let lastRequestAt: number | null = null
  let lastBlock: LastBlock | null = null
  let lastFailure: LastFailure | null = null
  let retryAttempts = 0
  let retryNextDelayMs = 0
  let mutedUntil: number | null = null
  let halted = false
  let haltReason: string | null = null
  let lockHeldAt = 0
  let lockHolder: string | null = null

  function silenceRemainingMs(): number {
    if (silenceUntil <= 0) return 0
    return Math.max(0, Math.ceil(silenceUntil - now()))
  }

  function publish(): void {
    const remaining = silenceRemainingMs()
    const lockStats = lock.stats()
    reportStatus({
      phase,
      rhythm: {
        silent: remaining > 0,
        silenceRemainingMs: remaining,
        todayRequests: daily.snapshot().todayRequests,
        dailyBudget: config.rhythm.dailyBudget,
        lastRequestAt,
        msSinceLastRequest: lastRequestAt === null ? null : Math.max(0, now() - lastRequestAt),
        lastBlock: lastBlock === null ? null : { ...lastBlock },
      },
      queue: { pending: queue.size(), maxPending: config.queue.maxPending },
      lock: {
        held: lockStats.held,
        heldBy: lockStats.held ? lockHolder : null,
        heldMs: lockStats.held && lockHeldAt > 0 ? Math.max(0, now() - lockHeldAt) : 0,
      },
      retry: { attempts: retryAttempts, nextDelayMs: retryNextDelayMs },
      safety: {
        testAccountOnly: config.safety.testAccountOnly,
        mutedUntil,
        halted,
        haltReason,
      },
      lastFailure: lastFailure === null ? null : { ...lastFailure },
    })
  }

  function setBlock(reason: LastBlock['reason'], until?: number): void {
    lastBlock = until === undefined ? { reason, at: now() } : { reason, at: now(), until }
    reportMetric('rhythm.blocked', 1)
    publish()
  }

  async function wait(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError()
    await sleep(Math.max(0, Math.round(ms)), signal)
    if (signal.aborted) throw abortError()
  }

  function createLease(releaseLock: () => void): Lease {
    let released = false
    let sent = false

    return {
      markSent(): void {
        if (released || sent) return
        sent = true
        daily.record()
        lastRequestAt = now()
        reportMetric('rhythm.request')
        reportMetric('rhythm.today_requests', daily.snapshot().todayRequests)
        publish()
      },

      markFailure(code: string, message: string, retryable: boolean): number {
        if (released) return 0
        const at = now()
        lastFailure = { at, code, message }
        const attempt = retryAttempts + 1
        const decision = nextRetry({ attempt, code, config, random })
        const blocked = !retryable || isNeverRetryCode(code)
        let delayMs = 0
        if (!blocked && decision.retry) {
          // M22：首次退避不得低于 baseDelayMs（±30% 抖动的下沿可能低于 5s）。
          delayMs = Math.max(config.retry.baseDelayMs, decision.delayMs)
        }
        if (delayMs > 0) {
          retryAttempts = attempt
          retryNextDelayMs = delayMs
          reportMetric('rhythm.retry_backoff_ms', delayMs)
        } else {
          retryAttempts = 0
          retryNextDelayMs = 0
        }
        reportMetric('rhythm.failure')
        if (isMuteCode(code)) {
          mutedUntil = deriveMutedUntil(message, at)
          if (config.safety.haltOnMute) {
            halted = true
            haltReason = `muted:${code}`
          }
          reportMetric('rhythm.mute')
          setBlock('mute-halt', mutedUntil ?? undefined)
        } else {
          publish()
        }
        return delayMs
      },

      markSuccess(): void {
        if (released) return
        retryAttempts = 0
        retryNextDelayMs = 0
        // 冷却只体现在下一次 acquire 的 jitter 上，这里直接回到 idle。
        phase = 'idle'
        publish()
      },

      release(): void {
        if (released) return
        released = true
        releaseLock()
        lockHeldAt = 0
        lockHolder = null
        queue.leave()

        const today = daily.snapshot().todayRequests
        const perRequests = Math.max(1, config.rhythm.silenceScale.perRequests)
        if (today >= perRequests) {
          // 与 silenceDuration 的口径对齐：第一个 perRequests 只给基础静默，
          // 之后每满 perRequests 升一档（等价 floor(n / perRequests - 1) 步）。
          const ms = silenceDuration({ config, todayRequests: today - perRequests, random })
          silenceUntil = now() + ms
          reportMetric('rhythm.silence_ms', ms)
          phase = 'silence'
        } else if (silenceRemainingMs() > 0) {
          phase = 'silence'
        } else {
          phase = retryNextDelayMs > 0 ? 'cooldown' : 'idle'
        }
        publish()
      },
    }
  }

  async function acquire(options: AcquireOptions = {}): Promise<Lease> {
    if (disposed) {
      throw new FreetokenError('PERMANENT', 'freetoken: rhythm controller is disposed')
    }
    // 熔断优先：mute 后必须人工重启控制器才能恢复（D26 / R16）。
    if (halted) {
      setBlock('mute-halt', mutedUntil ?? undefined)
      throw new FreetokenError(
        'PERMANENT',
        `freetoken: sending halted${haltReason ? ` (${haltReason})` : ''}; restart required`,
      )
    }
    if (!daily.canSend()) {
      setBlock('daily-budget')
      throw rhythmError(
        'DAILY_BUDGET',
        `freetoken: daily budget exhausted (${config.rhythm.dailyBudget}/day)`,
      )
    }
    if (!queue.tryEnter()) {
      setBlock('queue-full')
      throw rhythmError(
        'QUEUE_FULL',
        `freetoken: too many pending requests (maxPending=${config.queue.maxPending})`,
      )
    }

    const attemptAbort = new AbortController()
    const signal = attemptAbort.signal
    const onAbort = (): void => attemptAbort.abort()
    if (options.signal?.aborted || lifetime.signal.aborted) attemptAbort.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    lifetime.signal.addEventListener('abort', onAbort, { once: true })

    let releaseLock: (() => void) | undefined
    try {
      phase = 'aggregating'
      publish()

      // 静默：等到期为止；sleep 完成后静默即视为消费掉
      // （注入 sleep 可能不推进 now，不能循环重算，必须一次消费）。
      const remaining = silenceRemainingMs()
      if (remaining > 0) {
        phase = 'silence'
        setBlock('silence', silenceUntil)
        await wait(remaining, signal)
        silenceUntil = 0
        publish()
      }

      releaseLock = await lock.acquire(signal)
      lockHeldAt = now()
      lockHolder = describeRequest(options)
      phase = 'jittering'
      publish()

      // R11 / M21：发送前抖动；硬下限由 nextJitter 夹取保证。
      const jitterMs = nextJitter({ range: config.rhythm.jitterMs, random })
      reportMetric('rhythm.jitter_ms', jitterMs)
      await wait(jitterMs, signal)

      // 全局最小间隔（保守模式）：无论 jitter 抽到多少，两次真实请求之间至少隔 minRequestGapMs。
      // 工具循环最容易在数秒内连发多次；封禁事件后这是最重要的护栏（D33）。
      const minGap = Math.max(0, Math.round(config.safety.minRequestGapMs))
      if (minGap > 0 && lastRequestAt !== null) {
        const waitGap = minGap - (now() - lastRequestAt)
        if (waitGap > 0) {
          phase = 'cooldown'
          reportMetric('rhythm.min_gap_ms', waitGap)
          await wait(waitGap, signal)
        }
      }

      // D15：超限不丢调用，只追加更长间隔（再叠一次 jitter + 30–60s）。
      const turnKey = turnKeyOf(options)
      if (burst.countOf(turnKey) >= config.rhythm.maxCallsPerTurn) {
        const extraJitter = nextJitter({ range: config.rhythm.jitterMs, random })
        const extraGap =
          BURST_GAP_MIN_MS + Math.round(random() * (BURST_GAP_MAX_MS - BURST_GAP_MIN_MS))
        const gapMs = extraJitter + extraGap
        phase = 'jittering'
        setBlock('burst-cap', now() + gapMs)
        reportMetric('rhythm.burst_gap_ms', gapMs)
        await wait(gapMs, signal)
      }
      burst.observe(turnKey)

      phase = 'sending'
      publish()
      reportMetric('rhythm.sending')
      const lease = createLease(releaseLock)
      releaseLock = undefined
      return lease
    } catch (error) {
      if (releaseLock) {
        releaseLock()
        releaseLock = undefined
        lockHeldAt = 0
        lockHolder = null
      }
      queue.leave()
      phase = 'idle'
      publish()
      throw error
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      lifetime.signal.removeEventListener('abort', onAbort)
    }
  }

  function snapshot(): RhythmSnapshot {
    const remaining = silenceRemainingMs()
    return structuredClone({
      phase,
      silent: remaining > 0,
      silenceRemainingMs: remaining,
      todayRequests: daily.snapshot().todayRequests,
      lastRequestAt,
      queuePending: queue.size(),
      lockHeld: lock.stats().held,
      lastBlock,
      retry: { attempts: retryAttempts, nextDelayMs: retryNextDelayMs },
      maxCallsPerTurn: config.rhythm.maxCallsPerTurn,
      dailyBudget: config.rhythm.dailyBudget,
    })
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    lifetime.abort()
    silenceUntil = 0
    phase = 'idle'
    publish()
  }

  return { acquire, snapshot, dispose }
}