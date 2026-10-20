import assert from 'node:assert/strict'
import { DailyBudget } from '../lib/rhythm/daily.js'

// budget=0 不限
const unlimited = new DailyBudget({ budget: 0, now: () => 0 })
assert.equal(unlimited.canSend(), true)
assert.equal(unlimited.remaining(), Number.POSITIVE_INFINITY)
for (let i = 0; i < 100; i += 1) unlimited.record()
assert.equal(unlimited.canSend(), true)
assert.equal(unlimited.snapshot().todayRequests, 100)

// budget=2：第三次拒绝
let clock = new Date(2026, 9, 20, 10, 0, 0).getTime()
const limited = new DailyBudget({ budget: 2, now: () => clock })
assert.equal(limited.canSend(), true)
limited.record()
limited.record()
assert.equal(limited.canSend(), false)
assert.equal(limited.remaining(), 0)
assert.equal(limited.snapshot().todayRequests, 2)
assert.equal(limited.snapshot().resetAt, new Date(2026, 9, 21, 0, 0, 0).getTime())

// 跨日自动归零
clock = new Date(2026, 9, 21, 0, 0, 1).getTime()
assert.equal(limited.canSend(), true)
assert.equal(limited.snapshot().todayRequests, 0)
assert.equal(limited.snapshot().dayKey, '2026-10-21')

// 负预算夹到 0（不限）
const clamped = new DailyBudget({ budget: -5, now: () => clock })
assert.equal(clamped.remaining(), Number.POSITIVE_INFINITY)

console.log('check-daily-budget: PASS')
