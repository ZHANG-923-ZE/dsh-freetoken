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
assert.equal(snapshot.rhythm.dailyBudget, 20)
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

// S1.4 / S2：会话所有权与常驻守护必须在 status 契约里可见（面板据此显示）
assert.equal(typeof enabled.session, 'object')
assert.equal(enabled.session.contextMode, 'chained', 'default feed mode must be visible in status')
assert.equal(enabled.session.persistent, true, 'chained implies persistent sessions')
assert.equal(enabled.session.keepAliveState, 'idle')
assert.equal(enabled.session.keepAliveRestarts, 0)
// full 模式下必须显示为“会轮换”（反向验证：两种模式不能都报 persistent）
const fullCfg = normalizeConfig({ enabled: true, session: { contextMode: 'full' } })
const fullSnap = disabledSnapshot(fullCfg)
assert.equal(fullSnap.session.contextMode, 'full')
assert.equal(fullSnap.session.persistent, false)
// 凭证年龄字段存在（未知时为 null）
assert.ok('credentialAgeMs' in enabled.login, 'login.credentialAgeMs must exist in the contract')

// 嵌套对象必须**浅合并**：只写一个子字段不能抹掉同级其它字段
// （真实踩过的坑：onAuthRefreshed 只写 login 的三个字段，会把 credentialAgeMs 抹掉；
//  keep-alive 只写 session.keepAlive*，会把 contextMode/persistent 抹掉）
{
  const store2 = createStatusStore(enabled)
  store2.update({ login: { loggedIn: true, lastVerifiedAt: 123, lastError: null } })
  const l = store2.snapshot().login
  assert.equal(l.loggedIn, true)
  assert.equal(l.lastVerifiedAt, 123)
  assert.equal(
    l.credentialAgeMs,
    enabled.login.credentialAgeMs,
    'partial login update must not wipe credentialAgeMs',
  )

  store2.update({ session: { keepAliveState: 'alive', keepAliveRestarts: 2 } })
  const s = store2.snapshot().session
  assert.equal(s.keepAliveState, 'alive')
  assert.equal(s.keepAliveRestarts, 2)
  assert.equal(s.contextMode, enabled.session.contextMode, 'partial session update must not wipe contextMode')
  assert.equal(s.persistent, enabled.session.persistent, 'partial session update must not wipe persistent')

  // rhythm/safety 同理（rhythm backend 与 real backend 同时写 status）
  store2.update({ rhythm: { silent: true } })
  assert.equal(store2.snapshot().rhythm.todayRequests, enabled.rhythm.todayRequests)
  assert.equal(store2.snapshot().rhythm.dailyBudget, enabled.rhythm.dailyBudget)
}

console.log('check-status-shape: PASS')
