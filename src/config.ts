/**
 * dsh-Freetoken 配置：默认值、归一化与边界夹取。
 *
 * 纯函数模块：不读写文件、不访问网络、不加载任何重模块。
 * 关闭态（enabled:false）的行为完全由这里决定，因此本模块必须保持极轻。
 *
 * v1.1 增补（2026-10-20，工作流 8.12.1.2）：
 *  - transport 仅允许 browser（PoW 禁止 Node 回退）；
 *  - 新增 identity（设备固化/单实例）、retry（随机退避）、safety（止损熔断）、
 *    narration 去重、protocol 内容约束、backend 可插拔。
 */

export type BackendKind = 'cdp' | 'dom'
export type Mode = 'dev' | 'stable'

export interface Range {
  min: number
  max: number
}

export interface FreetokenConfig {
  enabled: boolean
  mode: Mode
  autoStartBrowser: boolean
  captureLoginOnStart: boolean
  /** 仅 browser：PoW 必须在真实浏览器页内完成，禁止 Node 侧回退。 */
  transport: 'browser'
  /** 执行后端：cdp 已实现；dom 为长期可插拔选项（v1 明确报错）。 */
  backend: BackendKind
  statusCommand: boolean
  identity: {
    persistDevice: boolean
    singleInstance: boolean
  }
  narration: {
    enabled: boolean
    dedupeWindowMs: number
    maxRepeats: number
  }
  batch: {
    enabled: boolean
    windowMs: number
    maxCalls: number
    maxTokens: number
  }
  queue: {
    enabled: boolean
    maxPending: number
  }
  coalesce: {
    enabled: boolean
    maxConsumers: number
  }
  localTitle: {
    enabled: boolean
    maxChars: number
  }
  retry: {
    maxRetries: number
    baseDelayMs: number
    factor: number
    maxDelayMs: number
    jitterRatio: number
  }
  safety: {
    testAccountOnly: boolean
    haltOnMute: boolean
    /** 任意两次真实网页请求之间的最小间隔（含跨 turn），0=不限制。 */
    minRequestGapMs: number
  }
  rhythm: {
    jitterMs: Range
    maxCallsPerTurn: number
    silenceMs: Range
    silenceScale: {
      perRequests: number
      stepMs: number
      capMs: number
    }
    dailyBudget: number
    longRunThreshold: number
    rateWindowMs: number
    rateMaxInWindow: number
  }
  session: {
    reuseTurns: number
    maxSlots: number
    cleanup: 'deferred' | 'keep'
    cleanupBatch: Range
    cleanupDelayMs: Range
    cleanupGapMs: Range
  }
  protocol: {
    serialToolCalls: boolean
    autoContinue: boolean
    maxContinuations: number
    forbidProbingQuestions: boolean
  }
  prompt: {
    maxChars: number
  }
}

/** 默认配置：保守、默认关闭。所有边界与工作流 D1–D30 一致。 */
export const DEFAULT_CONFIG: FreetokenConfig = Object.freeze({
  enabled: false,
  mode: 'dev',
  autoStartBrowser: false,
  captureLoginOnStart: false,
  transport: 'browser',
  backend: 'cdp',
  statusCommand: true,
  identity: { persistDevice: true, singleInstance: true },
  narration: { enabled: true, dedupeWindowMs: 90000, maxRepeats: 2 },
  batch: { enabled: true, windowMs: 200, maxCalls: 4, maxTokens: 8000 },
  queue: { enabled: true, maxPending: 8 },
  coalesce: { enabled: true, maxConsumers: 4 },
  localTitle: { enabled: true, maxChars: 32 },
  retry: { maxRetries: 3, baseDelayMs: 5000, factor: 2, maxDelayMs: 120000, jitterRatio: 0.3 },
  safety: { testAccountOnly: true, haltOnMute: true, minRequestGapMs: 15000 },
  rhythm: {
    jitterMs: { min: 2000, max: 5000 },
    // 保守模式（2026-10-20 封禁事件后，用户拍板收紧；见 Decision Log D33）
    maxCallsPerTurn: 2,
    silenceMs: { min: 30000, max: 60000 },
    silenceScale: { perRequests: 10, stepMs: 120000, capMs: 600000 },
    dailyBudget: 100,
    longRunThreshold: 15,
    rateWindowMs: 1800000,
    rateMaxInWindow: 20,
  },
  session: {
    reuseTurns: 20,
    maxSlots: 6,
    cleanup: 'deferred',
    cleanupBatch: { min: 6, max: 10 },
    cleanupDelayMs: { min: 60000, max: 120000 },
    cleanupGapMs: { min: 800, max: 2500 },
  },
  protocol: {
    serialToolCalls: true,
    autoContinue: true,
    maxContinuations: 1,
    forbidProbingQuestions: true,
  },
  prompt: { maxChars: 400000 },
}) as FreetokenConfig

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRecord(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key]
  return isRecord(value) ? value : {}
}

function readBool(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof source[key] === 'boolean' ? source[key] : fallback
}

function readInt(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = source[key]
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, Math.round(raw)))
}

function readFloat(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = source[key]
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, raw))
}

function readRange(
  source: Record<string, unknown>,
  key: string,
  fallback: Range,
  bounds: { min: number; max: number },
): Range {
  const value = readRecord(source, key)
  const min = readInt(value, 'min', fallback.min, bounds.min, bounds.max)
  const max = readInt(value, 'max', fallback.max, bounds.min, bounds.max)
  return { min: Math.min(min, max), max: Math.max(min, max) }
}

function readEnum<T extends string>(
  source: Record<string, unknown>,
  key: string,
  fallback: T,
  allowed: readonly T[],
): T {
  const value = source[key]
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/**
 * 归一化任意输入为完整配置。
 * 未知字段被忽略；数字越界被夹取；嵌套对象可为部分值。
 * 不可接受的 transport/backend 值一律回落到安全默认。
 */
export function normalizeConfig(raw: unknown): FreetokenConfig {
  const source = isRecord(raw) ? raw : {}
  const identity = readRecord(source, 'identity')
  const narration = readRecord(source, 'narration')
  const batch = readRecord(source, 'batch')
  const queue = readRecord(source, 'queue')
  const coalesce = readRecord(source, 'coalesce')
  const localTitle = readRecord(source, 'localTitle')
  const retry = readRecord(source, 'retry')
  const safety = readRecord(source, 'safety')
  const rhythm = readRecord(source, 'rhythm')
  const silenceScale = readRecord(rhythm, 'silenceScale')
  const session = readRecord(source, 'session')
  const protocol = readRecord(source, 'protocol')
  const prompt = readRecord(source, 'prompt')

  return {
    enabled: readBool(source, 'enabled', DEFAULT_CONFIG.enabled),
    mode: readEnum(source, 'mode', DEFAULT_CONFIG.mode, ['dev', 'stable']),
    autoStartBrowser: readBool(source, 'autoStartBrowser', DEFAULT_CONFIG.autoStartBrowser),
    captureLoginOnStart: readBool(source, 'captureLoginOnStart', DEFAULT_CONFIG.captureLoginOnStart),
    // R14/R21：只允许真实浏览器路径；任何其它值回落 browser。
    transport: readEnum(source, 'transport', DEFAULT_CONFIG.transport, ['browser']),
    backend: readEnum(source, 'backend', DEFAULT_CONFIG.backend, ['cdp', 'dom']),
    statusCommand: readBool(source, 'statusCommand', DEFAULT_CONFIG.statusCommand),
    identity: {
      persistDevice: readBool(identity, 'persistDevice', DEFAULT_CONFIG.identity.persistDevice),
      singleInstance: readBool(identity, 'singleInstance', DEFAULT_CONFIG.identity.singleInstance),
    },
    narration: {
      enabled: readBool(narration, 'enabled', DEFAULT_CONFIG.narration.enabled),
      dedupeWindowMs: readInt(
        narration,
        'dedupeWindowMs',
        DEFAULT_CONFIG.narration.dedupeWindowMs,
        0,
        600000,
      ),
      maxRepeats: readInt(narration, 'maxRepeats', DEFAULT_CONFIG.narration.maxRepeats, 0, 10),
    },
    batch: {
      enabled: readBool(batch, 'enabled', DEFAULT_CONFIG.batch.enabled),
      windowMs: readInt(batch, 'windowMs', DEFAULT_CONFIG.batch.windowMs, 0, 2000),
      maxCalls: readInt(batch, 'maxCalls', DEFAULT_CONFIG.batch.maxCalls, 1, 16),
      maxTokens: readInt(batch, 'maxTokens', DEFAULT_CONFIG.batch.maxTokens, 256, 64000),
    },
    queue: {
      enabled: readBool(queue, 'enabled', DEFAULT_CONFIG.queue.enabled),
      maxPending: readInt(queue, 'maxPending', DEFAULT_CONFIG.queue.maxPending, 1, 64),
    },
    coalesce: {
      enabled: readBool(coalesce, 'enabled', DEFAULT_CONFIG.coalesce.enabled),
      maxConsumers: readInt(coalesce, 'maxConsumers', DEFAULT_CONFIG.coalesce.maxConsumers, 1, 16),
    },
    localTitle: {
      enabled: readBool(localTitle, 'enabled', DEFAULT_CONFIG.localTitle.enabled),
      maxChars: readInt(localTitle, 'maxChars', DEFAULT_CONFIG.localTitle.maxChars, 8, 120),
    },
    retry: {
      maxRetries: readInt(retry, 'maxRetries', DEFAULT_CONFIG.retry.maxRetries, 0, 10),
      baseDelayMs: readInt(retry, 'baseDelayMs', DEFAULT_CONFIG.retry.baseDelayMs, 500, 600000),
      factor: readFloat(retry, 'factor', DEFAULT_CONFIG.retry.factor, 1, 10),
      maxDelayMs: readInt(retry, 'maxDelayMs', DEFAULT_CONFIG.retry.maxDelayMs, 1000, 3600000),
      jitterRatio: readFloat(retry, 'jitterRatio', DEFAULT_CONFIG.retry.jitterRatio, 0, 1),
    },
    safety: {
      testAccountOnly: readBool(safety, 'testAccountOnly', DEFAULT_CONFIG.safety.testAccountOnly),
      haltOnMute: readBool(safety, 'haltOnMute', DEFAULT_CONFIG.safety.haltOnMute),
      minRequestGapMs: readInt(
        safety,
        'minRequestGapMs',
        DEFAULT_CONFIG.safety.minRequestGapMs,
        0,
        600000,
      ),
    },
    rhythm: {
      jitterMs: readRange(rhythm, 'jitterMs', DEFAULT_CONFIG.rhythm.jitterMs, { min: 0, max: 30000 }),
      maxCallsPerTurn: readInt(
        rhythm,
        'maxCallsPerTurn',
        DEFAULT_CONFIG.rhythm.maxCallsPerTurn,
        1,
        16,
      ),
      silenceMs: readRange(rhythm, 'silenceMs', DEFAULT_CONFIG.rhythm.silenceMs, {
        min: 0,
        max: 300000,
      }),
      silenceScale: {
        perRequests: readInt(
          silenceScale,
          'perRequests',
          DEFAULT_CONFIG.rhythm.silenceScale.perRequests,
          1,
          1000,
        ),
        stepMs: readInt(silenceScale, 'stepMs', DEFAULT_CONFIG.rhythm.silenceScale.stepMs, 0, 60000),
        capMs: readInt(silenceScale, 'capMs', DEFAULT_CONFIG.rhythm.silenceScale.capMs, 0, 600000),
      },
      dailyBudget: readInt(rhythm, 'dailyBudget', DEFAULT_CONFIG.rhythm.dailyBudget, 0, 100000),
      longRunThreshold: readInt(
        rhythm,
        'longRunThreshold',
        DEFAULT_CONFIG.rhythm.longRunThreshold,
        0,
        100,
      ),
      rateWindowMs: readInt(rhythm, 'rateWindowMs', DEFAULT_CONFIG.rhythm.rateWindowMs, 60000, 86400000),
      rateMaxInWindow: readInt(
        rhythm,
        'rateMaxInWindow',
        DEFAULT_CONFIG.rhythm.rateMaxInWindow,
        0,
        10000,
      ),
    },
    session: {
      reuseTurns: readInt(session, 'reuseTurns', DEFAULT_CONFIG.session.reuseTurns, 0, 1000),
      maxSlots: readInt(session, 'maxSlots', DEFAULT_CONFIG.session.maxSlots, 1, 64),
      cleanup: readEnum(session, 'cleanup', DEFAULT_CONFIG.session.cleanup, ['deferred', 'keep']),
      cleanupBatch: readRange(session, 'cleanupBatch', DEFAULT_CONFIG.session.cleanupBatch, {
        min: 1,
        max: 50,
      }),
      cleanupDelayMs: readRange(session, 'cleanupDelayMs', DEFAULT_CONFIG.session.cleanupDelayMs, {
        min: 1000,
        max: 600000,
      }),
      cleanupGapMs: readRange(session, 'cleanupGapMs', DEFAULT_CONFIG.session.cleanupGapMs, {
        min: 0,
        max: 60000,
      }),
    },
    protocol: {
      serialToolCalls: readBool(protocol, 'serialToolCalls', DEFAULT_CONFIG.protocol.serialToolCalls),
      autoContinue: readBool(protocol, 'autoContinue', DEFAULT_CONFIG.protocol.autoContinue),
      maxContinuations: readInt(
        protocol,
        'maxContinuations',
        DEFAULT_CONFIG.protocol.maxContinuations,
        0,
        10,
      ),
      forbidProbingQuestions: readBool(
        protocol,
        'forbidProbingQuestions',
        DEFAULT_CONFIG.protocol.forbidProbingQuestions,
      ),
    },
    prompt: {
      maxChars: readInt(prompt, 'maxChars', DEFAULT_CONFIG.prompt.maxChars, 120000, 1500000),
    },
  }
}
