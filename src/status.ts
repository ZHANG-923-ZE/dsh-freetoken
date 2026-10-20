/**
 * 状态快照：插件对自己的运行状态保持唯一事实来源。
 *
 * 只做内存聚合；关闭态下不写文件、不发请求、不建定时器。
 * v1.1 增补：风险指标（lastRequestAt / msSinceLastRequest / todayRequests）、
 * 止损熔断、身份固化、重试退避、narration 去重计数。
 */

import type { FreetokenConfig } from './config.js'

export type RhythmPhase = 'idle' | 'aggregating' | 'jittering' | 'sending' | 'silence' | 'cooldown'

export interface LastBlock {
  reason: 'silence' | 'daily-budget' | 'burst-cap' | 'queue-full' | 'mute-halt' | 'manual'
  at: number
  until?: number
}

export interface LastFailure {
  at: number
  code: string
  message: string
}

export interface StatusSnapshot {
  enabled: boolean
  started: boolean
  phase: RhythmPhase
  login: {
    loggedIn: boolean
    lastVerifiedAt: number | null
    lastError: string | null
  }
  identity: {
    deviceId: string | null
    backend: 'cdp' | 'dom'
    singleInstance: boolean
  }
  browser: {
    running: boolean
    pid: number | null
  }
  lock: {
    held: boolean
    heldBy: string | null
    heldMs: number
  }
  queue: {
    pending: number
    maxPending: number
  }
  rhythm: {
    silent: boolean
    silenceRemainingMs: number
    todayRequests: number
    dailyBudget: number
    lastRequestAt: number | null
    msSinceLastRequest: number | null
    lastBlock: LastBlock | null
  }
  retry: {
    attempts: number
    nextDelayMs: number
  }
  safety: {
    testAccountOnly: boolean
    mutedUntil: number | null
    halted: boolean
    haltReason: string | null
  }
  lastFailure: LastFailure | null
  narration: {
    model: string | null
    local: string | null
    dedupeSuppressed: number
  }
  metrics: {
    requests: number
    titleSaved: number
    coalesced: number
    batchSplit: number
    partialFailure: number
    requestsPerTurnMedian: number
  }
  lazyLoaded: string[]
  updatedAt: number
}

/** 关闭态快照：不依赖任何运行时对象，供命令/面板读取。 */
export function disabledSnapshot(config: FreetokenConfig): StatusSnapshot {
  return {
    enabled: config.enabled,
    started: false,
    phase: 'idle',
    login: { loggedIn: false, lastVerifiedAt: null, lastError: null },
    identity: { deviceId: null, backend: config.backend, singleInstance: config.identity.singleInstance },
    browser: { running: false, pid: null },
    lock: { held: false, heldBy: null, heldMs: 0 },
    queue: { pending: 0, maxPending: config.queue.maxPending },
    rhythm: {
      silent: false,
      silenceRemainingMs: 0,
      todayRequests: 0,
      dailyBudget: config.rhythm.dailyBudget,
      lastRequestAt: null,
      msSinceLastRequest: null,
      lastBlock: null,
    },
    retry: { attempts: 0, nextDelayMs: 0 },
    safety: {
      testAccountOnly: config.safety.testAccountOnly,
      mutedUntil: null,
      halted: false,
      haltReason: null,
    },
    lastFailure: null,
    narration: { model: null, local: null, dedupeSuppressed: 0 },
    metrics: {
      requests: 0,
      titleSaved: 0,
      coalesced: 0,
      batchSplit: 0,
      partialFailure: 0,
      requestsPerTurnMedian: 0,
    },
    lazyLoaded: [],
    updatedAt: Date.now(),
  }
}

export interface StatusStore {
  /** 浅合并顶层字段（嵌套字段需整体给出）。 */
  update(patch: Partial<StatusSnapshot>): void
  snapshot(): StatusSnapshot
}

/** 创建内存状态存储；深拷贝出口，避免调用方改到内部对象。 */
export function createStatusStore(initial: StatusSnapshot): StatusStore {
  let current: StatusSnapshot = structuredClone(initial)
  return {
    update(patch) {
      current = { ...current, ...structuredClone(patch), updatedAt: Date.now() }
    },
    snapshot() {
      return structuredClone(current)
    },
  }
}
