import assert from 'node:assert/strict'
import { normalizeConfig } from '../lib/config.js'
import { isRetryableCode, nextRetry } from '../lib/rhythm/retry.js'

const config = normalizeConfig({ enabled: true })
const fixed = (value) => () => value

// 可重试码判定
assert.equal(isRetryableCode('EMPTY_RESPONSE'), true)
assert.equal(isRetryableCode('TRANSPORT'), true)
assert.equal(isRetryableCode('AUTH'), false)
assert.equal(isRetryableCode('POW_REQUIRES_BROWSER'), false)
assert.equal(isRetryableCode(undefined), false)

// 指数增长 + 抖动边界：attempt1 基准 5000，抖动 ±30% ⇒ [3500, 6500]
const firstLow = nextRetry({ attempt: 1, code: 'TRANSPORT', config, random: fixed(0) })
const firstHigh = nextRetry({ attempt: 1, code: 'TRANSPORT', config, random: fixed(1) })
assert.equal(firstLow.retry, true)
assert.equal(firstLow.delayMs, 3500)
assert.equal(firstHigh.delayMs, 6500)

// attempt2 基准 10000；attempt3 基准 20000；且严格递增（同一随机点）
const a2 = nextRetry({ attempt: 2, code: 'TRANSPORT', config, random: fixed(0.5) }).delayMs
const a3 = nextRetry({ attempt: 3, code: 'TRANSPORT', config, random: fixed(0.5) }).delayMs
assert.equal(a2, 10000)
assert.equal(a3, 20000)
assert.ok(a3 > a2)

// 上限夹取：factor 很大时不超过 maxDelayMs
const big = normalizeConfig({ enabled: true, retry: { baseDelayMs: 60000, factor: 10, maxDelayMs: 120000 } })
assert.equal(nextRetry({ attempt: 3, code: 'TRANSPORT', config: big, random: fixed(1) }).delayMs, 120000)

// 非重试码 / 超过最大次数
assert.equal(nextRetry({ attempt: 1, code: 'AUTH', config, random: fixed(0.5) }).retry, false)
assert.equal(nextRetry({ attempt: 1, code: 'RATE_LIMIT', config: normalizeConfig({ enabled: true, retry: { maxRetries: 0 } }), random: fixed(0.5) }).retry, false)
assert.equal(nextRetry({ attempt: 4, code: 'TRANSPORT', config, random: fixed(0.5) }).reason, 'max-retries')

// 非法 attempt
assert.equal(nextRetry({ attempt: 0, code: 'TRANSPORT', config, random: fixed(0.5) }).retry, false)

console.log('check-retry: PASS')
