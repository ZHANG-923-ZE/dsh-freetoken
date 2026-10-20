/**
 * 失败重试的随机退避（R12）。
 *
 * 指数退避 + 抖动，禁止快速连续重试；AUTH / mute / QUOTA 一律不重试（等多久都没用，
 * 且重试只会把风险面扩大）。纯函数，random 可注入，便于离线验证分布边界。
 */

import type { FreetokenConfig } from '../config.js'

export const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'EMPTY_RESPONSE',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'RATE_LIMIT',
])

export function isRetryableCode(code: string | undefined): boolean {
  return typeof code === 'string' && RETRYABLE_CODES.has(code)
}

export interface RetryDecision {
  retry: boolean
  /** 下一次尝试前的等待毫秒数；不重试时为 0。 */
  delayMs: number
  reason?: string
}

/**
 * 计算一次失败后的退避。
 * @param input.attempt 已失败次数（1 = 第一次失败）
 * @param input.code 失败码
 * @param input.config freetoken 配置
 * @param input.random 0..1 随机源（测试注入）
 */
export function nextRetry(
  input: {
    attempt: number
    code?: string
    config: FreetokenConfig
    random?: () => number
  },
): RetryDecision {
  const { attempt, code, config } = input
  const retry = config.retry
  if (!Number.isInteger(attempt) || attempt < 1) {
    return { retry: false, delayMs: 0, reason: 'invalid-attempt' }
  }
  if (attempt > retry.maxRetries) {
    return { retry: false, delayMs: 0, reason: 'max-retries' }
  }
  if (!isRetryableCode(code)) {
    return { retry: false, delayMs: 0, reason: `non-retryable:${code ?? 'unknown'}` }
  }
  const random = input.random ?? Math.random
  const base = retry.baseDelayMs * Math.pow(retry.factor, attempt - 1)
  const jitter = 1 + (random() * 2 - 1) * retry.jitterRatio
  const delayMs = Math.max(0, Math.min(retry.maxDelayMs, Math.round(base * jitter)))
  return { retry: true, delayMs }
}
