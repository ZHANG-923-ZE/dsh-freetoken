import assert from 'node:assert/strict'
import { Metrics } from '../lib/rhythm/metrics.js'

const metrics = new Metrics()
assert.deepEqual(metrics.snapshot(), {
  requests: 0,
  titleSaved: 0,
  coalesced: 0,
  batchSplit: 0,
  partialFailure: 0,
  queueWaitMsMedian: 0,
  batchSizeMedian: 0,
  samples: 0,
})

metrics.recordRequest()
metrics.recordRequest()
metrics.recordTitleSaved()
metrics.recordCoalesced()
metrics.recordBatchSplit()
metrics.recordPartialFailure()
let snap = metrics.snapshot()
assert.equal(snap.requests, 2)
assert.equal(snap.titleSaved, 1)
assert.equal(snap.coalesced, 1)
assert.equal(snap.batchSplit, 1)
assert.equal(snap.partialFailure, 1)

// 中位数（偶数取中间两数均值并取整）
metrics.recordQueueWait(10)
metrics.recordQueueWait(30)
assert.equal(metrics.snapshot().queueWaitMsMedian, 20)
metrics.recordQueueWait(50)
assert.equal(metrics.snapshot().queueWaitMsMedian, 30)

// 批大小中位数
metrics.recordBatchSize(2)
metrics.recordBatchSize(4)
metrics.recordBatchSize(6)
assert.equal(metrics.snapshot().batchSizeMedian, 4)

// 非法值被忽略
metrics.recordQueueWait(-1)
metrics.recordBatchSize(0)
assert.equal(metrics.snapshot().samples, 3)

// 样本上限：只保留最近 200
for (let i = 0; i < 500; i += 1) metrics.recordQueueWait(i)
snap = metrics.snapshot()
assert.equal(snap.samples, 200)
assert.ok(snap.queueWaitMsMedian >= 400)

console.log('check-metrics: PASS')
