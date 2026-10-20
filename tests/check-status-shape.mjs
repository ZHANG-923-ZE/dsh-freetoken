import assert from 'node:assert/strict'
import { normalizeConfig } from '../lib/config.js'
import { createStatusStore, disabledSnapshot } from '../lib/status.js'

const config = normalizeConfig({ enabled: false })
const snapshot = disabledSnapshot(config)

// M15/M27：风险指标字段必须存在且默认诚实
assert.equal(snapshot.enabled, false)
assert.equal(snapshot.started, false)
assert.equal(snapshot.login.loggedIn, false)
assert.equal(snapshot.login.lastVerifiedAt, null)
assert.equal(snapshot.identity.backend, 'cdp')
assert.equal(snapshot.browser.running, false)
assert.equal(snapshot.lock.held, false)
assert.equal(snapshot.queue.pending, 0)
assert.equal(snapshot.queue.maxPending, config.queue.maxPending)
assert.equal(snapshot.rhythm.silent, false)
assert.equal(snapshot.rhythm.silenceRemainingMs, 0)
assert.equal(snapshot.rhythm.todayRequests, 0)
assert.equal(snapshot.rhythm.dailyBudget, 100)
assert.equal(snapshot.rhythm.lastRequestAt, null)
assert.equal(snapshot.rhythm.msSinceLastRequest, null)
assert.equal(snapshot.rhythm.lastBlock, null)
assert.deepEqual(snapshot.retry, { attempts: 0, nextDelayMs: 0 })
assert.equal(snapshot.safety.testAccountOnly, true)
assert.equal(snapshot.safety.halted, false)
assert.equal(snapshot.lastFailure, null)
assert.equal(snapshot.narration.dedupeSuppressed, 0)
assert.deepEqual(snapshot.lazyLoaded, [])

// 更新器：浅合并 + 深拷贝出口（调用方改不到内部对象）
const store = createStatusStore(snapshot)
store.update({ phase: 'silence', rhythm: { ...snapshot.rhythm, silent: true, silenceRemainingMs: 12000 } })
const after = store.snapshot()
assert.equal(after.phase, 'silence')
assert.equal(after.rhythm.silent, true)
assert.equal(after.rhythm.silenceRemainingMs, 12000)
after.rhythm.silent = false
assert.equal(store.snapshot().rhythm.silent, true, 'snapshot must be a detached copy')
assert.ok(after.updatedAt >= snapshot.updatedAt)

// enabled 开启的初始快照仍保持 started=false（未 start）
const enabled = disabledSnapshot(normalizeConfig({ enabled: true }))
assert.equal(enabled.enabled, true)
assert.equal(enabled.started, false)

console.log('check-status-shape: PASS')
