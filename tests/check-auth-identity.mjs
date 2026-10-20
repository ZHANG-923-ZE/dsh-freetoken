import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tempHome = mkdtempSync(path.join(tmpdir(), 'ft-state-'))
process.env.DSH_HOME = tempHome

try {
  const { saveAuth, readAuth, clearAuth, maskToken, authPath } = await import('../lib/transport/auth.js')
  const { ensureDevice, readDevice, acquireTransportLock, readTransportLock, lockPath } = await import('../lib/transport/identity.js')

  // 凭证：保存/读取/掩码/清除
  saveAuth({ version: 1, account: { id: 'a', displayName: 'tester' }, auth: { token: 'abcd1234efgh5678' }, savedAt: 1 })
  const read = readAuth()
  assert.equal(read?.auth.token, 'abcd1234efgh5678')
  assert.equal(read?.account.displayName, 'tester')
  assert.equal(maskToken(read.auth.token), 'abcd****5678')
  assert.equal(clearAuth(), true)
  assert.equal(readAuth(), undefined)
  assert.equal(clearAuth(), false)

  // 损坏文件按未登录处理
  writeFileSync(authPath(), '{not json')
  assert.equal(readAuth(), undefined)

  // 设备身份：持久化同一 deviceId
  const first = ensureDevice()
  const second = ensureDevice()
  assert.equal(first.deviceId, second.deviceId)
  assert.equal(readDevice()?.deviceId, first.deviceId)

  // 单实例锁：第二次获取被拒绝
  const release = acquireTransportLock('cdp')
  let failure
  try {
    acquireTransportLock('cdp')
  } catch (error) {
    failure = error
  }
  assert.equal(failure?.code, 'TRANSPORT_IN_USE')
  release()
  assert.equal(readTransportLock(), undefined)

  // 陈旧锁（进程不存在）可被接管
  writeFileSync(lockPath(), JSON.stringify({ pid: 999999, backend: 'cdp', startedAt: Date.now() }))
  const release2 = acquireTransportLock('cdp')
  assert.equal(readTransportLock()?.pid, process.pid)
  release2()

  console.log('check-auth-identity: PASS')
} finally {
  rmSync(tempHome, { recursive: true, force: true })
}
