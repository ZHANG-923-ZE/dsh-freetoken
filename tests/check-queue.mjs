import assert from 'node:assert/strict'
import { PendingQueue } from '../lib/rhythm/queue.js'

const queue = new PendingQueue({ maxPending: 2 })
assert.equal(queue.tryEnter(), true)
assert.equal(queue.tryEnter(), true)
assert.equal(queue.isFull(), true)
assert.equal(queue.tryEnter(), false, 'must fail fast when full')
assert.deepEqual(queue.stats(), { pending: 2, maxPending: 2, rejected: 1 })

queue.leave()
assert.equal(queue.isFull(), false)
assert.equal(queue.tryEnter(), true)

// 多余的 leave 不会把计数打成负数
queue.leave()
queue.leave()
queue.leave()
assert.equal(queue.size(), 0)

// 上限夹取：0 → 1
const clamped = new PendingQueue({ maxPending: 0 })
assert.equal(clamped.tryEnter(), true)
assert.equal(clamped.tryEnter(), false)

console.log('check-queue: PASS')
