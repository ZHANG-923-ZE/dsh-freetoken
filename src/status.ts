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
    /**
     * 凭证快照年龄（ms）；未知为 null（S1.4）。
     *
     * 刻意设为**可选**：`status.update()` 对嵌套对象是整体替换，若设成必填，
     * 每个只关心登录态的调用点都要重复填一遍，容易填错或忘更新。
     * 由 `refreshCredentialAge()` 统一写入。
     */
    credentialAgeMs?: number | null
  }
  /** 会话所有权/投喂模式（S1.4 / S2）：面板据此显示"后台会话是否常驻"。 */
  session: {
    /** 上下文投喂方式。 */
    contextMode: 'full' | 'chained'
    /** 链式投喂下会话不轮换 ⇒ 一个 DSH 会话长期对应同一条网页版会话。 */
    persistent: boolean
    /** 传输层常驻守护最近一次判定。 */
    keepAliveState: 'idle' | 'alive' | 'logged-out' | 'off-origin' | 'dead'
    /** 守护累计重启浏览器次数（误关自愈的证据）。 */
    keepAliveRestarts: number
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
    login: { loggedIn: false, lastVerifiedAt: null, lastError: null, credentialAgeMs: null },
    session: {
      contextMode: config.session.contextMode,
      persistent: config.session.contextMode === 'chained',
      keepAliveState: 'idle',
      keepAliveRestarts: 0,
    },
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

/**
 * 创建内存状态存储；深拷贝出口，避免调用方改到内部对象。
 *
 * ⚠️ 嵌套对象**浅合并**（`{...current.session, ...patch.session}`），
 * 不是整体替换 —— 整体替换会让"只写一个子字段"的调用点把同级的其它字段抹掉。
 *
 * 这个坑真实发生过：`onAuthRefreshed` 只写 `login.loggedIn/lastVerifiedAt/lastError`，
 * 整体替换会把 `login.credentialAgeMs` 抹成 undefined；`session` 同理
 * （keep-alive 只写 keepAlive* 两个字段，却会抹掉 contextMode/persistent）。
 * 浅合并让每个写入方只声明自己关心的子字段。
 */
export function createStatusStore(initial: StatusSnapshot): StatusStore {
  let current: StatusSnapshot = structuredClone(initial)
  return {
    update(patch) {
      const cloned = structuredClone(patch)
      const next: StatusSnapshot = { ...current, ...cloned, updatedAt: Date.now() }
      // 嵌套浅合并：只覆盖 patch 里**显式给出**的子字段。
      if (cloned.login) next.login = { ...current.login, ...cloned.login }
      if (cloned.session) next.session = { ...current.session, ...cloned.session }
      if (cloned.rhythm) next.rhythm = { ...current.rhythm, ...cloned.rhythm }
      if (cloned.safety) next.safety = { ...current.safety, ...cloned.safety }
      if (cloned.retry) next.retry = { ...current.retry, ...cloned.retry }
      if (cloned.lock) next.lock = { ...current.lock, ...cloned.lock }
      if (cloned.queue) next.queue = { ...current.queue, ...cloned.queue }
      if (cloned.browser) next.browser = { ...current.browser, ...cloned.browser }
      if (cloned.identity) next.identity = { ...current.identity, ...cloned.identity }
      if (cloned.narration) next.narration = { ...current.narration, ...cloned.narration }
      if (cloned.metrics) next.metrics = { ...current.metrics, ...cloned.metrics }
      current = next
    },
    snapshot() {
      return structuredClone(current)
    },
  }
}
