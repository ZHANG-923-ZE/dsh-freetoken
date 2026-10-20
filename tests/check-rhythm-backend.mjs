import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeConfig } from '../lib/config.js'
import { createRhythmBackend } from '../lib/rhythm/backend.js'

const tempHome = mkdtempSync(path.join(tmpdir(), 'ft-rhythm-'))
process.env.DSH_HOME = tempHome

const baseConfig = normalizeConfig({
  enabled: true,
  coalesce: { enabled: true },
  rhythm: {
    jitterMs: { min: 0, max: 1 },
    silenceMs: { min: 0, max: 0 },
    dailyBudget: 0,
    maxCallsPerTurn: 8,
  },
  retry: { maxRetries: 3, baseDelayMs: 500, factor: 2, maxDelayMs: 5000, jitterRatio: 0 },
})

function makeInner(options = {}) {
  const state = { calls: 0, concurrent: 0, maxConcurrent: 0, chats: 0 }
  return {
    state,
    kind: 'cdp',
    async start() {},
    async *stream(request) {
      state.calls += 1
      if ((request.purpose ?? 'chat') === 'chat') state.chats += 1
      state.concurrent += 1
      state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent)
      try {
        if (options.failFirst && state.calls === 1) {
          const error = new Error('transport boom')
          error.code = 'TRANSPORT'
          error.retryable = true
          throw error
        }
        if (options.failCode) {
          const error = new Error('auth boom')
          error.code = options.failCode
          error.retryable = true
          throw error
        }
        if (options.onStream) await options.onStream(request, state)
        yield { kind: 'text', text: `reply-${state.calls}` }
        yield { kind: 'finish', reason: 'stop' }
      } finally {
        state.concurrent -= 1
      }
    },
    async close() {},
  }
}

async function collect(iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

try {
  // 1) 串行锁：两路 chat 并发 → 内层最大并发 1
  {
    const inner = makeInner()
    const backend = createRhythmBackend(inner, baseConfig)
    const request = { provider: 'deepseek-web', model: 'deepseek-chat', prompt: 'p', messages: [], thinkingEnabled: false, modelType: 'default' }
    const [a, b] = await Promise.all([collect(backend.stream(request)), collect(backend.stream({ ...request }))])
    assert.equal(inner.state.maxConcurrent, 1, 'two concurrent streams must never overlap')
    assert.ok(a.length > 0 && b.length > 0)
    await backend.close()
  }

  // 2) L3 单飞：同 key 的 compaction 并发只发一次，后到者复用事件
  {
    const inner = makeInner()
    const metrics = []
    const backend = createRhythmBackend(inner, baseConfig, { onMetric: (name) => metrics.push(name) })
    const request = {
      provider: 'deepseek-web',
      model: 'deepseek-chat',
      prompt: 'same prompt',
      messages: [],
      thinkingEnabled: false,
      modelType: 'default',
      purpose: 'compaction',
      sessionId: 's1',
    }
    const [a, b] = await Promise.all([collect(backend.stream(request)), collect(backend.stream({ ...request }))])
    assert.equal(inner.state.calls, 1, 'coalesced second request must not hit the inner backend')
    assert.deepEqual(a, b, 'both consumers must observe the same events')
    assert.ok(metrics.includes('coalesced'), 'coalesced metric must be recorded')
    await backend.close()
  }

  // 3) 随机退避重试：首个可重试失败 → sleep >= baseDelay，第二次成功
  {
    const inner = makeInner({ failFirst: true })
    const sleeps = []
    const backend = createRhythmBackend(inner, baseConfig, {
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    const request = { provider: 'deepseek-web', model: 'deepseek-chat', prompt: 'p', messages: [], thinkingEnabled: false, modelType: 'default' }
    const chunks = await collect(backend.stream(request))
    assert.equal(inner.state.calls, 2, 'one retry expected')
    assert.ok(sleeps.length === 1 && sleeps[0] >= 500, `retry delay must be >= baseDelay (got ${sleeps[0]})`)
    assert.ok(chunks.some((c) => c.kind === 'text'))
    await backend.close()
  }

  // 4) AUTH 不重试
  {
    const inner = makeInner({ failCode: 'AUTH' })
    const backend = createRhythmBackend(inner, baseConfig, { sleep: async () => {} })
    const request = { provider: 'deepseek-web', model: 'deepseek-chat', prompt: 'p', messages: [], thinkingEnabled: false, modelType: 'default' }
    let failure
    try {
      await collect(backend.stream(request))
    } catch (error) {
      failure = error
    }
    assert.equal(failure?.code, 'AUTH')
    assert.equal(inner.state.calls, 1, 'AUTH must never retry')
    await backend.close()
  }

  // 5) 状态风险指标：lastRequestAt / todayRequests / lastBlock 由 controller 回填
  {
    const inner = makeInner()
    const patches = []
    const config = normalizeConfig({ ...baseConfig, rhythm: { ...baseConfig.rhythm, dailyBudget: 1 } })
    const backend = createRhythmBackend(inner, config, { onStatus: (patch) => patches.push(patch) })
    const request = { provider: 'deepseek-web', model: 'deepseek-chat', prompt: 'p', messages: [], thinkingEnabled: false, modelType: 'default' }
    await collect(backend.stream(request))
    const rhythmPatch = patches.filter((p) => p.rhythm).at(-1)
    assert.equal(typeof rhythmPatch.rhythm.lastRequestAt, 'number')
    assert.equal(rhythmPatch.rhythm.todayRequests, 1)
    assert.ok(rhythmPatch.rhythm.lastRequestAt > 0)
    // 第二次超过日预算：拒绝且 lastBlock 诚实
    let failure
    try {
      await collect(backend.stream(request))
    } catch (error) {
      failure = error
    }
    assert.equal(failure?.code, 'DAILY_BUDGET')
    assert.ok(patches.some((p) => p.rhythm?.lastBlock?.reason === 'daily-budget'))
    await backend.close()
  }

  // 6) 反向验证：关闭单飞后同 key compaction 会真的发两次
  {
    const inner = makeInner()
    const config = normalizeConfig({ ...baseConfig, coalesce: { enabled: false } })
    const backend = createRhythmBackend(inner, config)
    const request = {
      provider: 'deepseek-web',
      model: 'deepseek-chat',
      prompt: 'same prompt',
      messages: [],
      thinkingEnabled: false,
      modelType: 'default',
      purpose: 'compaction',
      sessionId: 's1',
    }
    await Promise.all([collect(backend.stream(request)), collect(backend.stream({ ...request }))])
    assert.equal(inner.state.calls, 2, 'coalesce disabled => two real requests')
    await backend.close()
  }

  console.log('check-rhythm-backend: PASS')
} finally {
  rmSync(tempHome, { recursive: true, force: true })
}