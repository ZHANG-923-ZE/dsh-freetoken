import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tempHome = mkdtempSync(path.join(tmpdir(), 'ft-cons-'))
process.env.DSH_HOME = tempHome

try {
  const { normalizeConfig } = await import('../lib/config.js')
  const { createRhythmController } = await import('../lib/rhythm/controller.js')
  const { readUsage, writeUsage, localDayKey } = await import('../lib/transport/usage.js')

  // 1) 跨重启用量：同一天恢复，跨天清零
  writeUsage(7)
  assert.equal(readUsage()?.count, 7)
  assert.equal(readUsage()?.day, localDayKey())
  const { writeFileSync } = await import('node:fs')
  const { usagePath } = await import('../lib/transport/usage.js')
  writeFileSync(usagePath(), JSON.stringify({ day: '2000-01-01', count: 42 }))
  assert.equal(readUsage()?.count, 0, 'previous-day usage must reset to 0')

  // 2) 日预算从磁盘恢复：budget-1 + 1 次 ⇒ 刚好用满，下一次拒绝
  //    （D34 起默认 budget=20，所以这里按配置值推导，不写死 99/100）
  const config = normalizeConfig({
    enabled: true,
    rhythm: { jitterMs: { min: 0, max: 0 }, silenceMs: { min: 0, max: 0 } },
  })
  const budget = config.rhythm.dailyBudget
  assert.equal(budget, 20, 'default daily budget must be 20 (D34)')
  const c1 = createRhythmController({ config, initialTodayRequests: budget - 1 })
  const lease = await c1.acquire({ kind: 'chat' })
  lease.markSent()
  lease.release()
  assert.equal(c1.snapshot().todayRequests, budget)
  let budgetError
  try {
    await c1.acquire({ kind: 'chat' })
  } catch (error) {
    budgetError = error
  }
  assert.equal(budgetError?.code, 'DAILY_BUDGET')
  c1.dispose()

  // 3) 全局最小间隔：第二次发送前至少等待 minRequestGapMs（D34 起默认 60s）
  const sleeps = []
  const c2 = createRhythmController({
    config,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  const a = await c2.acquire({ kind: 'chat' })
  a.markSent()
  a.release()
  const b = await c2.acquire({ kind: 'chat' })
  b.markSent()
  b.release()
  assert.ok(
    sleeps.some((ms) => ms >= config.safety.minRequestGapMs - 200),
    `second send must wait >= minRequestGapMs (sleeps=${JSON.stringify(sleeps)})`,
  )
  c2.dispose()

  // 4) 【S3.1】滚动窗口限速真的生效：窗口内超过上限必须等配额
  {
    const windowConfig = normalizeConfig({
      enabled: true,
      rhythm: {
        jitterMs: { min: 0, max: 0 },
        silenceMs: { min: 0, max: 0 },
        longRunThreshold: 0, // 本节只验窗口，关掉长休避免互相干扰
        rateMaxInWindow: 3,
        rateWindowMs: 60_000,
        dailyBudget: 0,
      },
      safety: { minRequestGapMs: 0 },
    })
    let clock = 1_000_000
    const seen = []
    const c3 = createRhythmController({
      config: windowConfig,
      now: () => clock,
      sleep: async (ms) => {
        seen.push(ms)
        clock += ms // 睡眠推进时钟，模拟真实等待
      },
    })
    for (let i = 0; i < 3; i += 1) {
      const l = await c3.acquire({ kind: 'chat' })
      l.markSent()
      l.release()
      clock += 1000 // 每次间隔 1s，仍在窗口内
    }
    // 第 4 次应被窗口拦下并等待
    const before = seen.length
    const l4 = await c3.acquire({ kind: 'chat' })
    l4.markSent()
    l4.release()
    assert.ok(seen.length > before, '4th request in the window must wait for quota')
    assert.ok(
      seen.slice(before).some((ms) => ms > 1000),
      `rate window wait must be non-trivial (waits=${JSON.stringify(seen.slice(before))})`,
    )
    c3.dispose()
  }

  // 5) 【S3.1】连续请求长休真的生效：达到阈值后必须休
  {
    const longConfig = normalizeConfig({
      enabled: true,
      rhythm: {
        jitterMs: { min: 0, max: 0 },
        silenceMs: { min: 0, max: 0 },
        longRunThreshold: 2,
        longRunBreakMs: { min: 5000, max: 5000 },
        rateMaxInWindow: 0, // 本节只验长休
        dailyBudget: 0,
      },
      safety: { minRequestGapMs: 0 },
    })
    const seen = []
    const c4 = createRhythmController({
      config: longConfig,
      sleep: async (ms) => {
        seen.push(ms)
      },
    })
    for (let i = 0; i < 2; i += 1) {
      const l = await c4.acquire({ kind: 'chat' })
      l.markSent()
      l.release()
    }
    // 第 2 次之后已达到阈值 ⇒ 第 3 次 acquire 前必须长休
    const before = seen.length
    const l3 = await c4.acquire({ kind: 'chat' })
    l3.markSent()
    l3.release()
    assert.ok(
      seen.slice(before).some((ms) => ms >= 5000),
      `long-run break must trigger after threshold (waits=${JSON.stringify(seen.slice(before))})`,
    )
    c4.dispose()
  }

  // 6) 反向验证：关闭长休/窗口/静默/burst 后不得再有**实质**等待（避免"永久拖慢"）
  {
    const offConfig = normalizeConfig({
      enabled: true,
      rhythm: {
        jitterMs: { min: 0, max: 0 },
        silenceMs: { min: 0, max: 0 },
        // stepMs=0 ⇒ 静默不再随请求数增长（否则 10 次后仍会触发静默，与本用例目的冲突）
        silenceScale: { perRequests: 5, stepMs: 0, capMs: 0 },
        longRunThreshold: 0,
        rateMaxInWindow: 0,
        dailyBudget: 0,
        // burst 上限放开：默认 1 会让同 turnKey 的第二次起叠加 30–60s 间隔
        maxCallsPerTurn: 16,
      },
      safety: { minRequestGapMs: 0 },
    })
    const seen = []
    const c5 = createRhythmController({
      config: offConfig,
      sleep: async (ms) => {
        seen.push(ms)
      },
    })
    for (let i = 0; i < 10; i += 1) {
      const l = await c5.acquire({ kind: 'chat' })
      l.markSent()
      l.release()
    }
    // jitter/间隔为 0 时仍会调用 sleep(0)，这是实现细节；判据是"没有实质等待"。
    assert.ok(
      seen.every((ms) => ms <= 0),
      `with guards off there must be no positive sleeps (saw ${JSON.stringify(seen)})`,
    )
    c5.dispose()
  }

  console.log('check-conservative: PASS')
} finally {
  rmSync(tempHome, { recursive: true, force: true })
}
