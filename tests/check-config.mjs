import assert from 'node:assert/strict'
import { normalizeConfig, DEFAULT_CONFIG } from '../lib/config.js'

// 默认：关闭、保守节奏、风险约束
const defaults = normalizeConfig(undefined)
assert.equal(defaults.enabled, false, 'default enabled must be false')
assert.equal(defaults.transport, 'browser', 'only browser transport is allowed (PoW must stay in-page)')
assert.equal(defaults.backend, 'cdp')
assert.deepEqual(defaults.rhythm.jitterMs, { min: 2000, max: 5000 })
// D34（2026-10-21 用户裁决）：进一步降载 —— 一轮只发一次、日预算 20、最小间隔 60s、不自动续写
assert.equal(defaults.rhythm.maxCallsPerTurn, 1)
assert.equal(defaults.rhythm.dailyBudget, 20)
assert.equal(defaults.rhythm.rateMaxInWindow, 6)
assert.equal(defaults.rhythm.rateWindowMs, 1800000)
assert.equal(defaults.rhythm.longRunThreshold, 5)
assert.equal(defaults.rhythm.longRunBreakMs.min, 180000)
assert.equal(defaults.rhythm.longRunBreakMs.max, 300000)
assert.equal(defaults.protocol.autoContinue, false)
assert.equal(defaults.narration.enabled, true)
assert.equal(defaults.narration.dedupeWindowMs, 90000)
assert.equal(defaults.narration.maxRepeats, 2)
assert.equal(defaults.localTitle.enabled, true)
assert.equal(defaults.session.cleanup, 'deferred')
assert.equal(defaults.safety.minRequestGapMs, 60000)
assert.equal(defaults.protocol.maxContinuations, 1)
assert.equal(defaults.statusCommand, true)
assert.equal(defaults.identity.persistDevice, true)
assert.equal(defaults.identity.singleInstance, true)
assert.equal(defaults.retry.maxRetries, 3)
assert.equal(defaults.retry.baseDelayMs, 5000)
assert.equal(defaults.retry.factor, 2)
assert.equal(defaults.retry.maxDelayMs, 120000)
assert.equal(defaults.retry.jitterRatio, 0.3)
assert.equal(defaults.safety.testAccountOnly, true)
assert.equal(defaults.safety.haltOnMute, true)
assert.equal(defaults.protocol.forbidProbingQuestions, true)

// 部分嵌套：未给的字段用默认，给了的覆盖
const merged = normalizeConfig({
  enabled: true,
  narration: { enabled: false, dedupeWindowMs: 10000 },
  queue: { maxPending: 3 },
  rhythm: { jitterMs: { min: 3000 } },
  batch: { maxCalls: 2 },
  retry: { maxRetries: 1 },
})
assert.equal(merged.enabled, true)
assert.equal(merged.narration.enabled, false)
assert.equal(merged.narration.dedupeWindowMs, 10000)
assert.equal(merged.queue.maxPending, 3)
assert.deepEqual(merged.rhythm.jitterMs, { min: 3000, max: 5000 })
assert.equal(merged.batch.maxCalls, 2)
assert.equal(merged.retry.maxRetries, 1)
assert.deepEqual(merged.session.cleanupBatch, DEFAULT_CONFIG.session.cleanupBatch)

// 边界夹取 + 区间顺序自动纠正 + 非法枚举回落
const clamped = normalizeConfig({
  transport: 'node',
  backend: 'carrier-pigeon',
  rhythm: { jitterMs: { min: 999999, max: -5 }, maxCallsPerTurn: 999, dailyBudget: -1 },
  queue: { maxPending: 0 },
  batch: { maxCalls: 0, maxTokens: 1 },
  retry: { maxRetries: 99, baseDelayMs: 1, factor: 0, jitterRatio: 2 },
  narration: { dedupeWindowMs: -1, maxRepeats: 99 },
  prompt: { maxChars: 1 },
  session: { cleanup: 'immediate' },
  mode: 'prod',
})
assert.equal(clamped.transport, 'browser', 'transport node must not be accepted')
assert.equal(clamped.backend, 'cdp')
assert.deepEqual(clamped.rhythm.jitterMs, { min: 0, max: 30000 })
assert.equal(clamped.rhythm.maxCallsPerTurn, 16)
assert.equal(clamped.rhythm.dailyBudget, 0)
assert.equal(clamped.queue.maxPending, 1)
assert.equal(clamped.batch.maxCalls, 1)
assert.equal(clamped.batch.maxTokens, 256)
assert.equal(clamped.retry.maxRetries, 10)
assert.equal(clamped.retry.baseDelayMs, 500)
assert.equal(clamped.retry.factor, 1)
assert.equal(clamped.retry.jitterRatio, 1)
assert.equal(clamped.narration.dedupeWindowMs, 0)
assert.equal(clamped.narration.maxRepeats, 10)
assert.equal(clamped.prompt.maxChars, 120000)
assert.equal(clamped.session.cleanup, 'deferred')
assert.equal(clamped.mode, 'dev')

// dom 后端作为长期可插拔选项被接受（v1 运行时显式报错，但配置不拦）
assert.equal(normalizeConfig({ backend: 'dom' }).backend, 'dom')

// 非对象输入
assert.equal(normalizeConfig(null).enabled, false)
assert.equal(normalizeConfig('nope').enabled, false)
assert.equal(normalizeConfig([]).enabled, false)

// 不返回共享默认对象（避免调用方改到 DEFAULT_CONFIG）
const a = normalizeConfig(undefined)
a.rhythm.maxCallsPerTurn = 99
assert.equal(normalizeConfig(undefined).rhythm.maxCallsPerTurn, 1)
assert.equal(DEFAULT_CONFIG.rhythm.maxCallsPerTurn, 1)

console.log('check-config: PASS')
