import assert from 'node:assert/strict'
import { SingleFlight, coalesceKey } from '../lib/rhythm/coalesce.js'

// key 稳定：缺省字段不劈裂
assert.equal(
  coalesceKey({ provider: 'deepseek-web', model: 'deepseek-chat', sessionId: 's1' }),
  'deepseek-web|deepseek-chat|chat|s1||',
)
assert.notEqual(coalesceKey({ sessionId: 's1' }), coalesceKey({ sessionId: 's2' }))

// 同 key 并发：任务只跑一次，消费者共享结果
{
  const flight = new SingleFlight()
  let runs = 0
  const task = async () => {
    runs += 1
    await new Promise((resolve) => setTimeout(resolve, 10))
    return 'value'
  }
  const [a, b] = await Promise.all([flight.run('k', task), flight.run('k', task)])
  assert.equal(runs, 1)
  assert.equal(a, 'value')
  assert.equal(b, 'value')
  assert.equal(flight.stats().joined, 1)
  assert.equal(flight.stats().inflight, 0)
}

// 不同 key 独立执行
{
  const flight = new SingleFlight()
  let runs = 0
  const task = async () => {
    runs += 1
    return runs
  }
  await Promise.all([flight.run('a', task), flight.run('b', task)])
  assert.equal(runs, 2)
}

// 结束后可再次执行
{
  const flight = new SingleFlight()
  let runs = 0
  const task = async () => {
    runs += 1
    return runs
  }
  await flight.run('x', task)
  await flight.run('x', task)
  assert.equal(runs, 2)
}

// 任务失败后清理，不缓存错误
{
  const flight = new SingleFlight()
  let runs = 0
  const failing = async () => {
    runs += 1
    throw new Error('boom')
  }
  await assert.rejects(() => flight.run('f', failing))
  assert.equal(flight.stats().inflight, 0)
  await assert.rejects(() => flight.run('f', failing))
  assert.equal(runs, 2)
}

console.log('check-coalesce: PASS')
