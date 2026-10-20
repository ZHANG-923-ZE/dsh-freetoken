import assert from 'node:assert/strict'
import { BurstTracker } from '../lib/rhythm/burst.js'

const tracker = new BurstTracker({ maxCalls: 4 })

// 同一 turn 累积计数，第 5 个开始标记超限
const observations = [1, 2, 3, 4, 5].map(() => tracker.observe('turn-A'))
assert.deepEqual(observations.map((o) => o.count), [1, 2, 3, 4, 5])
assert.deepEqual(observations.map((o) => o.exceeded), [false, false, false, false, true])
assert.equal(tracker.countOf('turn-A'), 5)

// 不同 turn 独立计数
assert.equal(tracker.observe('turn-B').count, 1)
assert.equal(tracker.observe('turn-B').exceeded, false)
assert.equal(tracker.countOf('turn-B'), 2)

// reset 单个 turn / 全部
tracker.reset('turn-A')
assert.equal(tracker.countOf('turn-A'), 0)
assert.equal(tracker.countOf('turn-B'), 2)
tracker.reset()
assert.equal(tracker.size(), 0)

// 非法上限夹到 1
const strict = new BurstTracker({ maxCalls: 0 })
assert.equal(strict.observe('t').exceeded, false)
assert.equal(strict.observe('t').exceeded, true)

// 空 turnKey 归到 unknown，避免 undefined 键
assert.equal(tracker.observe('').turnKey, 'unknown')

console.log('check-burst: PASS')

