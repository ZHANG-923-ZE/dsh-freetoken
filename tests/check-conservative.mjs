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

  // 2) 日预算从磁盘恢复：99 + budget 100 ⇒ 只剩 1 次
  const config = normalizeConfig({ enabled: true, rhythm: { jitterMs: { min: 0, max: 0 }, silenceMs: { min: 0, max: 0 } } })
  const c1 = createRhythmController({ config, initialTodayRequests: 99 })
  const lease = await c1.acquire({ kind: 'chat' })
  lease.markSent()
  lease.release()
  assert.equal(c1.snapshot().todayRequests, 100)
  let budgetError
  try {
    await c1.acquire({ kind: 'chat' })
  } catch (error) {
    budgetError = error
  }
  assert.equal(budgetError?.code, 'DAILY_BUDGET')
  c1.dispose()

  // 3) 全局最小间隔：第二次发送前至少等待 minRequestGapMs（15s 默认）
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

  console.log('check-conservative: PASS')
} finally {
  rmSync(tempHome, { recursive: true, force: true })
}