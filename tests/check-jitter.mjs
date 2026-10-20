import assert from 'node:assert/strict'
import { nextJitter } from '../lib/rhythm/jitter.js'

const range = { min: 2000, max: 5000 }

// 固定区间：返回下限
assert.equal(nextJitter({ range: { min: 2000, max: 2000 } }), 2000)

// 10k 采样：全部在区间内、中位数接近几何均值 3162、非固定值
let seed = 123456789
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
const samples = Array.from({ length: 10_000 }, () => nextJitter({ range, random }))
assert.ok(samples.every((value) => value >= 2000 && value <= 5000), 'all samples inside range')
const sorted = [...samples].sort((a, b) => a - b)
const median = sorted[Math.floor(sorted.length / 2)]
assert.ok(Math.abs(median - 3162) < 250, `median ${median} should be near geometric mean`)
assert.ok(new Set(samples).size > 100, 'jitter must not be a fixed cycle')

// 下限硬约束：范围下限本身就不允许低于配置
assert.ok(samples.every((value) => value >= 2000))

// 注入均匀随机源时也不越界
const fixedRandom = () => 0.999999
assert.ok(nextJitter({ range, random: fixedRandom }) <= 5000)

console.log('check-jitter: PASS')
