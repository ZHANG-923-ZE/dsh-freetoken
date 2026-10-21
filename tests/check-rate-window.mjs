import assert from 'node:assert/strict'
import { RateWindow, LongRunGuard } from '../lib/rhythm/rate-window.js'

// ── RateWindow：滚动窗口限速 ────────────────────────────────────────────
{
  let clock = 1_000_000
  const rw = new RateWindow({ windowMs: 60_000, maxInWindow: 3, now: () => clock })
  assert.equal(rw.enabled, true)
  assert.deepEqual(rw.check(), { count: 0, waitMs: 0 })

  // 未达上限：不等待
  rw.record(); clock += 1000
  rw.record(); clock += 1000
  assert.equal(rw.check().waitMs, 0)
  assert.equal(rw.check().count, 2)

  // 达到上限：必须等最早那条滑出窗口
  rw.record(); clock += 1000
  const full = rw.check()
  assert.equal(full.count, 3)
  assert.ok(full.waitMs > 0, 'at limit the window must ask to wait')
  // 最早一条在 t0，窗口 60s ⇒ 等到 t0+60s
  assert.equal(full.waitMs, 60_000 - 3000)

  // 时间推进到窗口外：配额恢复
  clock += full.waitMs
  assert.equal(rw.check().waitMs, 0, 'after the window slides, quota must free up')
  assert.ok(rw.check().count < 3)

  // 关闭条件：maxInWindow=0 或 windowMs=0
  const off = new RateWindow({ windowMs: 60_000, maxInWindow: 0, now: () => clock })
  assert.equal(off.enabled, false)
  off.record(); off.record(); off.record()
  assert.equal(off.check().waitMs, 0, 'disabled rate window must never block')
  const off2 = new RateWindow({ windowMs: 0, maxInWindow: 5, now: () => clock })
  assert.equal(off2.enabled, false)
}

// ── LongRunGuard：连续请求长休 ──────────────────────────────────────────
{
  const guard = new LongRunGuard({
    threshold: 3,
    breakMs: { min: 10_000, max: 10_000 },
    random: () => 0.5,
  })
  assert.equal(guard.enabled, true)
  assert.equal(guard.observe().shouldBreak, false) // 1
  assert.equal(guard.observe().shouldBreak, false) // 2
  const third = guard.observe() // 3 ⇒ 触发
  assert.equal(third.shouldBreak, true)
  assert.equal(third.breakMs, 10_000)
  // 触发后归零：下一次不该立刻再休
  assert.equal(guard.observe().shouldBreak, false, 'counter must reset after a break')
  assert.equal(guard.count, 1)

  // 区间随机
  const ranged = new LongRunGuard({
    threshold: 1,
    breakMs: { min: 5000, max: 15000 },
    random: () => 0,
  })
  const d = ranged.observe()
  assert.equal(d.shouldBreak, true)
  assert.ok(d.breakMs >= 5000 && d.breakMs <= 15000)

  // 关闭：threshold=0
  const off = new LongRunGuard({ threshold: 0, breakMs: { min: 1000, max: 2000 } })
  assert.equal(off.enabled, false)
  for (let i = 0; i < 10; i += 1) {
    assert.equal(off.observe().shouldBreak, false, 'disabled guard must never break')
  }
}

// ── 反向验证：两个护栏互不影响 ──────────────────────────────────────────
{
  let clock = 5_000_000
  const rw = new RateWindow({ windowMs: 30_000, maxInWindow: 2, now: () => clock })
  const guard = new LongRunGuard({ threshold: 5, breakMs: { min: 1000, max: 1000 } })
  rw.record(); guard.observe()
  rw.record(); guard.observe()
  // 窗口已满但长休未到阈值：只有窗口该拦
  assert.ok(rw.check().waitMs > 0)
  assert.equal(guard.count, 2)
  clock += rw.check().waitMs
  assert.equal(rw.check().waitMs, 0, 'window freed while long-run counter kept counting')
  assert.equal(guard.count, 2, 'rate window must not reset the long-run counter')
}

console.log('check-rate-window: PASS')