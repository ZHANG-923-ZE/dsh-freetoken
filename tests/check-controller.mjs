/**
 * RhythmController 离线用例（确定性：注入 now / random / sleep）。
 * 覆盖：日预算拒绝、队列满、抖动区间与非均匀、20 次后静默、burst 只加间隔不丢调用、
 * 随机退避、AUTH/mute/QUOTA 不重试、串行锁、状态快照诚实、反向验证、dispose 与 abort。
 */
import assert from 'node:assert/strict'
import { normalizeConfig } from '../lib/config.js'
import { createRhythmController } from '../lib/rhythm/controller.js'

const NOW = Date.parse('2026-10-20T02:00:00Z')

function abortError() {
  const error = new Error('freetoken: aborted')
  error.name = 'AbortError'
  return error
}

/** 确定性 LCG（mulberry32）：同 seed 完全可复现。 */
function seeded(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function build(patch = {}, extra = {}) {
  const config = normalizeConfig({ enabled: true, ...patch })
  const sleeps = []
  const statuses = []
  const metrics = []
  const sleep =
    extra.sleep ??
    (async (ms, signal) => {
      if (signal?.aborted) throw abortError()
      sleeps.push(ms)
    })
  const controller = createRhythmController({
    config,
    now: extra.now ?? (() => NOW),
    random: extra.random ?? seeded(0xc0ffee),
    sleep,
    onStatus: (statusPatch) => statuses.push(statusPatch),
    onMetric: (name, value) => metrics.push([name, value]),
  })
  return { config, controller, sleeps, statuses, metrics }
}

function lastStatus(statuses) {
  assert.ok(statuses.length > 0, 'expected at least one status patch')
  return statuses[statuses.length - 1]
}

/** 只推进微任务（不依赖真实定时器）。 */
async function flushMicrotasks(times = 12) {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

const cases = []
function test(name, fn) {
  cases.push([name, fn])
}

test('daily budget rejects with DAILY_BUDGET and honest status', async () => {
  const h = build({ rhythm: { dailyBudget: 2 } })
  for (let i = 0; i < 2; i += 1) {
    const lease = await h.controller.acquire({ kind: 'chat' })
    lease.markSent()
    lease.release()
  }
  assert.equal(h.controller.snapshot().todayRequests, 2)
  await assert.rejects(h.controller.acquire({ kind: 'chat' }), (error) => {
    assert.equal(error.name, 'FreetokenError')
    assert.equal(error.code, 'DAILY_BUDGET')
    return true
  })
  const status = lastStatus(h.statuses)
  assert.equal(status.rhythm.lastBlock.reason, 'daily-budget')
  assert.equal(status.rhythm.todayRequests, 2)
  // 被拒绝的请求不得占用队列名额或锁
  assert.equal(h.controller.snapshot().queuePending, 0)
  assert.equal(h.controller.snapshot().lockHeld, false)
})

test('queue full fast-fails with QUEUE_FULL', async () => {
  const h = build({ queue: { maxPending: 1 } })
  const first = await h.controller.acquire({ kind: 'chat' })
  assert.equal(h.controller.snapshot().lockHeld, true)
  assert.equal(h.controller.snapshot().queuePending, 1)
  await assert.rejects(h.controller.acquire({ kind: 'chat' }), (error) => {
    assert.equal(error.code, 'QUEUE_FULL')
    return true
  })
  assert.equal(lastStatus(h.statuses).rhythm.lastBlock.reason, 'queue-full')
  first.release()
  assert.equal(h.controller.snapshot().queuePending, 0)
  assert.equal(h.controller.snapshot().lockHeld, false)
  const again = await h.controller.acquire({ kind: 'chat' })
  again.release()
})

test('jitter: 500 samples inside 2-5s, median >= 2s, non-uniform', async () => {
  const h = build({}, { random: seeded(123456789) })
  const samples = []
  for (let i = 0; i < 500; i += 1) {
    const before = h.sleeps.length
    const lease = await h.controller.acquire({ sessionId: `jitter-${i}`, kind: 'chat' })
    assert.equal(h.sleeps.length, before + 1, 'fresh turnKey must only sleep the jitter')
    samples.push(h.sleeps[before])
    lease.release()
  }
  assert.equal(samples.length, 500)
  assert.ok(
    samples.every((ms) => ms >= 2000 && ms <= 5000),
    'all jitter samples must be within [2000,5000]',
  )
  const sorted = [...samples].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  assert.ok(median >= 2000, `median ${median} must be >= 2000ms`)
  assert.ok(median >= 3000, `log-normal median should be near sqrt(2000*5000)~3162ms, got ${median}`)
  const distinct = new Set(samples).size
  assert.ok(distinct > 50, `jitter must not be fixed/quantized: only ${distinct} distinct values`)
})

test('silence starts after the 10th request and is consumed by the next acquire', async () => {
  const h = build({}, { random: seeded(42) })
  const sessionId = 'silence-session'
  for (let i = 0; i < 10; i += 1) {
    const lease = await h.controller.acquire({ sessionId, kind: 'chat' })
    lease.markSent()
    lease.release()
    if (i < 9) {
      assert.equal(
        h.controller.snapshot().silent,
        false,
        `silence must not start before 10 requests (i=${i})`,
      )
    }
  }
  const paused = h.controller.snapshot()
  assert.equal(paused.todayRequests, 10)
  assert.equal(paused.silent, true)
  assert.equal(paused.phase, 'silence')
  assert.ok(
    paused.silenceRemainingMs >= 30000 && paused.silenceRemainingMs <= 60000,
    `silence after 20 requests must be 30-60s, got ${paused.silenceRemainingMs}ms`,
  )
  const status = lastStatus(h.statuses)
  assert.equal(status.rhythm.silent, true)
  assert.equal(status.rhythm.silenceRemainingMs, paused.silenceRemainingMs)
  // 反向验证：下一次 acquire 必须先睡满静默剩余，然后才进入抖动
  const before = h.sleeps.length
  const next = await h.controller.acquire({ sessionId, kind: 'chat' })
  assert.equal(h.sleeps[before], paused.silenceRemainingMs, 'next acquire must sleep the full silence first')
  assert.equal(h.controller.snapshot().silent, false, 'silence is consumed after waiting')
  next.release()
})

test('burst cap adds a 30-60s gap but never drops the call', async () => {
  const h = build({ rhythm: { maxCallsPerTurn: 2 } }, { random: seeded(7) })
  const sessionId = 'burst-session'
  const first = await h.controller.acquire({ sessionId, kind: 'chat' })
  assert.equal(h.sleeps.length, 1, 'call 1: jitter only')
  first.release()
  const second = await h.controller.acquire({ sessionId, kind: 'chat' })
  assert.equal(h.sleeps.length, 2, 'call 2: jitter only')
  second.release()
  const before = h.sleeps.length
  const third = await h.controller.acquire({ sessionId, kind: 'chat' })
  const added = h.sleeps.slice(before)
  assert.equal(added.length, 2, 'call 3 over cap: jitter + one extra gap')
  const [jitter, gap] = added
  assert.ok(jitter >= 2000 && jitter <= 5000, `jitter ${jitter}`)
  assert.ok(gap >= 32000 && gap <= 65000, `burst gap ${gap} must be jitter + 30-60s`)
  // “绝不丢弃”：第三个 lease 依然可用且真正发出
  assert.equal(typeof third.markSent, 'function')
  third.markSent()
  assert.equal(h.controller.snapshot().todayRequests, 1)
  assert.equal(lastStatus(h.statuses).rhythm.lastBlock.reason, 'burst-cap')
  third.release()
})

test('reverse check: maxCallsPerTurn=1 delays the second acquire', async () => {
  const h = build({ rhythm: { maxCallsPerTurn: 1 } }, { random: seeded(11) })
  const sessionId = 'reverse-session'
  const first = await h.controller.acquire({ sessionId, kind: 'chat' })
  assert.equal(h.sleeps.length, 1, 'first call has no burst gap')
  first.release()
  const before = h.sleeps.length
  const second = await h.controller.acquire({ sessionId, kind: 'chat' })
  assert.equal(h.sleeps.length - before, 2, 'second call must be delayed by a burst gap')
  const gap = h.sleeps[h.sleeps.length - 1]
  assert.ok(gap >= 32000 && gap <= 65000)
  second.release()
})

test('retry: first backoff >= 5s, grows, jitters, resets after markSuccess', async () => {
  const h = build({}, { random: seeded(99) })
  const lease = await h.controller.acquire({ kind: 'chat' })
  lease.markSent()
  const first = lease.markFailure('TRANSPORT', 'socket closed', true)
  assert.ok(first >= 5000 && first <= 6500, `first backoff ${first} must be 5-6.5s`)
  const second = lease.markFailure('TRANSPORT', 'socket closed', true)
  assert.ok(second >= 7000 && second <= 13000, `second backoff ${second}`)
  assert.ok(second > first, `second ${second} must exceed first ${first}`)
  const third = lease.markFailure('TRANSPORT', 'socket closed', true)
  assert.ok(third >= 14000 && third <= 26000, `third backoff ${third}`)
  let snap = h.controller.snapshot()
  assert.equal(snap.retry.attempts, 3)
  assert.equal(snap.retry.nextDelayMs, third)
  const status = lastStatus(h.statuses)
  assert.deepEqual(status.retry, { attempts: 3, nextDelayMs: third })
  assert.equal(status.lastFailure.code, 'TRANSPORT')
  // 超过 maxRetries(3) => 不再重试
  assert.equal(lease.markFailure('TRANSPORT', 'still down', true), 0)
  snap = h.controller.snapshot()
  assert.equal(snap.retry.attempts, 0)
  assert.equal(snap.retry.nextDelayMs, 0)
  // 成功清零，phase 回到 idle
  lease.markSuccess()
  assert.deepEqual(h.controller.snapshot().retry, { attempts: 0, nextDelayMs: 0 })
  assert.equal(h.controller.snapshot().phase, 'idle')
  lease.release()
  assert.equal(h.controller.snapshot().phase, 'idle')

  // 抖动：同一 attempt，不同随机点给出不同退避（首跳仍有 5s 下限托底）
  const low = build({}, { random: () => 0 })
  const lowLease = await low.controller.acquire({ kind: 'chat' })
  const lowDelay = lowLease.markFailure('TIMEOUT', 'timeout', true)
  assert.equal(lowDelay, 5000)
  const high = build({}, { random: () => 1 })
  const highLease = await high.controller.acquire({ kind: 'chat' })
  const highDelay = highLease.markFailure('TIMEOUT', 'timeout', true)
  assert.equal(highDelay, 6500)
  assert.notEqual(lowDelay, highDelay)
})

test('AUTH / QUOTA are never retried and do not accumulate attempts', async () => {
  const h = build({}, { random: seeded(5) })
  const lease = await h.controller.acquire({ kind: 'chat' })
  lease.markSent()
  assert.equal(lease.markFailure('AUTH', 'invalid token', true), 0)
  let status = lastStatus(h.statuses)
  assert.equal(status.lastFailure.code, 'AUTH')
  assert.deepEqual(status.retry, { attempts: 0, nextDelayMs: 0 })
  assert.equal(lease.markFailure('QUOTA', 'quota exceeded', true), 0)
  assert.deepEqual(h.controller.snapshot().retry, { attempts: 0, nextDelayMs: 0 })
  // retryable=false 时即便失败码本身可重试也不退避
  assert.equal(lease.markFailure('TRANSPORT', 'forced non-retryable', false), 0)
  assert.deepEqual(h.controller.snapshot().retry, { attempts: 0, nextDelayMs: 0 })
  lease.release()
})

test('mute halts sending and derives mutedUntil from the message', async () => {
  const h = build({}, { random: seeded(6) })
  const lease = await h.controller.acquire({ kind: 'chat' })
  lease.markSent()
  const mutedAt = Date.parse('2026-10-20T12:00:00Z')
  assert.equal(lease.markFailure('muted', 'muted until 2026-10-20T12:00:00Z', true), 0)
  const status = lastStatus(h.statuses)
  assert.equal(status.safety.halted, true)
  assert.equal(status.safety.mutedUntil, mutedAt)
  assert.equal(status.rhythm.lastBlock.reason, 'mute-halt')
  assert.equal(h.controller.snapshot().retry.nextDelayMs, 0)
  // 熔断后 acquire 直接拒绝（需人工重启控制器，D26）
  await assert.rejects(h.controller.acquire({ kind: 'chat' }), (error) => {
    assert.equal(error.code, 'PERMANENT')
    return true
  })
  lease.release()
})

test('serial lock: two concurrent acquires never send at the same time', async () => {
  const h = build({ queue: { maxPending: 8 } }, { random: seeded(3) })
  const first = await h.controller.acquire({ sessionId: 'lock-a', kind: 'chat' })
  assert.equal(h.controller.snapshot().lockHeld, true)

  let secondLease = null
  const pending = h.controller.acquire({ sessionId: 'lock-b', kind: 'chat' }).then((lease) => {
    secondLease = lease
    return lease
  })
  await flushMicrotasks()
  assert.equal(secondLease, null, 'second acquire must wait while the lock is held')
  assert.equal(h.controller.snapshot().lockHeld, true)
  assert.equal(h.controller.snapshot().queuePending, 2, 'both requests tracked as in-flight')

  first.release()
  const second = await pending
  assert.ok(second)
  assert.equal(h.controller.snapshot().lockHeld, true)
  assert.equal(h.controller.snapshot().queuePending, 1)
  second.release()
  assert.equal(h.controller.snapshot().lockHeld, false)
  assert.equal(h.controller.snapshot().queuePending, 0)
})

test('snapshot and status patches are honest and structuredClone-safe', async () => {
  const h = build()
  let snap = h.controller.snapshot()
  assert.equal(snap.phase, 'idle')
  assert.equal(snap.silent, false)
  assert.equal(snap.silenceRemainingMs, 0)
  assert.equal(snap.todayRequests, 0)
  assert.equal(snap.lastRequestAt, null)
  assert.equal(snap.queuePending, 0)
  assert.equal(snap.lockHeld, false)
  assert.equal(snap.lastBlock, null)
  assert.deepEqual(snap.retry, { attempts: 0, nextDelayMs: 0 })
  assert.equal(snap.maxCallsPerTurn, h.config.rhythm.maxCallsPerTurn)
  assert.equal(snap.dailyBudget, h.config.rhythm.dailyBudget)
  assert.equal(h.statuses.length, 0, 'construction must not publish status')

  const lease = await h.controller.acquire({ sessionId: 'honest', purpose: 'chat', kind: 'chat' })
  assert.equal(h.controller.snapshot().phase, 'sending')
  lease.markSent()
  snap = h.controller.snapshot()
  assert.equal(snap.lastRequestAt, NOW)
  assert.equal(snap.todayRequests, 1)
  const status = lastStatus(h.statuses)
  assert.deepEqual(Object.keys(status.rhythm).sort(), [
    'dailyBudget',
    'lastBlock',
    'lastRequestAt',
    'msSinceLastRequest',
    'silenceRemainingMs',
    'silent',
    'todayRequests',
  ])
  assert.equal(status.rhythm.lastRequestAt, NOW)
  assert.equal(status.rhythm.msSinceLastRequest, 0)
  assert.equal(status.rhythm.todayRequests, 1)
  assert.deepEqual(status.retry, { attempts: 0, nextDelayMs: 0 })
  assert.equal(status.lock.held, true)
  assert.equal(status.queue.pending, 1)

  lease.release()
  snap = h.controller.snapshot()
  assert.equal(snap.queuePending, 0)
  assert.equal(snap.lockHeld, false)
  assert.equal(snap.phase, 'idle')
  // 每个 patch 都必须是 structuredClone 安全的纯对象（无类实例 / 函数）
  for (const patch of h.statuses) {
    assert.deepEqual(structuredClone(patch), patch)
  }
  assert.ok(h.metrics.some(([name]) => name === 'rhythm.request'))
  assert.ok(h.metrics.some(([name]) => name === 'rhythm.jitter_ms'))
})

test('dispose cancels pending sleeps, goes idle and rejects new acquires', async () => {
  // 挂起式 sleep：只在收到 abort 时拒绝，用来验证 dispose 的取消能力
  const hangingSleep = (_ms, signal) =>
    new Promise((_resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError())
        return
      }
      const onAbort = () => {
        signal?.removeEventListener('abort', onAbort)
        reject(abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  const h = build({}, { sleep: hangingSleep })
  const pending = h.controller.acquire({ kind: 'chat' }).then(
    () => null,
    (error) => error,
  )
  await flushMicrotasks()
  assert.equal(h.controller.snapshot().lockHeld, true, 'acquire holds the lock while sleeping')
  assert.equal(h.controller.snapshot().queuePending, 1)
  h.controller.dispose()
  assert.equal(h.controller.snapshot().phase, 'idle')
  const error = await pending
  assert.equal(error?.name, 'AbortError')
  await flushMicrotasks()
  assert.equal(h.controller.snapshot().queuePending, 0)
  assert.equal(h.controller.snapshot().lockHeld, false)
  await assert.rejects(h.controller.acquire({ kind: 'chat' }), (err) => {
    assert.equal(err.code, 'PERMANENT')
    return true
  })
})

test('caller abort rejects without leaking queue or lock', async () => {
  const h = build()
  const aborter = new AbortController()
  aborter.abort()
  await assert.rejects(h.controller.acquire({ kind: 'chat', signal: aborter.signal }), (error) => {
    assert.equal(error.name, 'AbortError')
    return true
  })
  await flushMicrotasks()
  assert.equal(h.controller.snapshot().queuePending, 0)
  assert.equal(h.controller.snapshot().lockHeld, false)
  assert.equal(h.controller.snapshot().phase, 'idle')
})

async function run() {
  for (const [name, fn] of cases) {
    await fn()
    console.log(`PASS ${name}`)
  }
  console.log(`check-controller: PASS (${cases.length}/${cases.length} cases)`)
}

try {
  await run()
} catch (error) {
  console.error('check-controller: FAIL')
  console.error(error)
  process.exit(1)
}