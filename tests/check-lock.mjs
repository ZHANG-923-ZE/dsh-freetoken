import assert from 'node:assert/strict'
import { SerialLock } from '../lib/rhythm/lock.js'

// 串行：第二路必须等第一路释放
{
  const lock = new SerialLock()
  const order = []
  const release1 = await lock.acquire()
  order.push('first')
  assert.equal(lock.stats().held, true)

  const second = lock.acquire().then((release) => {
    order.push('second')
    release()
  })
  assert.equal(lock.stats().pending, 1)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(order, ['first'], 'second must wait')

  release1()
  await second
  assert.deepEqual(order, ['first', 'second'])
  assert.equal(lock.stats().held, false)
}

// release 幂等
{
  const lock = new SerialLock()
  const release = await lock.acquire()
  release()
  release()
  const again = await lock.acquire()
  again()
}

// 等待中可取消，且不泄漏计数
{
  const lock = new SerialLock()
  const release = await lock.acquire()
  const controller = new AbortController()
  const waiting = lock.acquire(controller.signal).catch((error) => error)
  controller.abort()
  const error = await waiting
  assert.equal(error?.name, 'AbortError')
  assert.equal(lock.stats().pending, 0)
  release()
  const next = await lock.acquire()
  next()
}

// FIFO 顺序
{
  const lock = new SerialLock()
  const seen = []
  const release = await lock.acquire()
  const waits = ['a', 'b', 'c'].map((name) =>
    lock.acquire().then((done) => {
      seen.push(name)
      done()
    }),
  )
  release()
  await Promise.all(waits)
  assert.deepEqual(seen, ['a', 'b', 'c'])
}

console.log('check-lock: PASS')
