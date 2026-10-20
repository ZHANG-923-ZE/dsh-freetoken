import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tempHome = mkdtempSync(path.join(tmpdir(), 'ft-session-'))
process.env.DSH_HOME = tempHome

try {
  const { SessionStore, sessionsPath } = await import('../lib/session/mapping.js')

  // 新 Harness 会话：无槽 → 记录新网页会话
  let clock = 1000
  const store = new SessionStore({ now: () => clock++ })
  assert.equal(store.lease('dsh-A', 20), undefined)
  const first = store.record('dsh-A', 'web-A1')
  assert.equal(first.turns, 1)
  assert.equal(store.get('dsh-A')?.webSessionId, 'web-A1')

  // 复用：lease 命中并累计轮数
  clock += 10
  const reused = store.lease('dsh-A', 20)
  assert.equal(reused?.webSessionId, 'web-A1')
  assert.equal(reused?.turns, 2)

  // 不同 Harness 会话绝不共用网页会话
  assert.equal(store.lease('dsh-B', 20), undefined)
  store.record('dsh-B', 'web-B1')
  assert.notEqual(store.get('dsh-A')?.webSessionId, store.get('dsh-B')?.webSessionId)

  // 轮换阈值：达到 reuseTurns 后不再复用
  let rotate = new SessionStore({ file: path.join(tempHome, 'rotate.json'), now: () => clock++ })
  rotate.record('dsh-C', 'web-C1')
  rotate.lease('dsh-C', 1) // turns 1 -> 2，超过 1 轮上限
  assert.equal(rotate.lease('dsh-C', 1), undefined)
  rotate.record('dsh-C', 'web-C2')
  assert.equal(rotate.get('dsh-C')?.webSessionId, 'web-C2')

  // 持久化：重建 store 仍能恢复
  const file = path.join(tempHome, 'resume.json')
  const a = new SessionStore({ file })
  a.record('dsh-R', 'web-R1')
  const b = new SessionStore({ file })
  assert.equal(b.get('dsh-R')?.webSessionId, 'web-R1')

  // 损坏文件按空映射处理，不抛
  writeFileSync(file, '{broken')
  const c = new SessionStore({ file })
  assert.equal(c.get('dsh-R'), undefined)

  // 退役
  const d = new SessionStore({ file: path.join(tempHome, 'retire.json') })
  d.record('dsh-X', 'web-X1')
  assert.equal(d.retire('dsh-X'), true)
  assert.equal(d.get('dsh-X'), undefined)

  // 槽上限：淘汰最久未用，不抛
  const tiny = new SessionStore({ file: path.join(tempHome, 'cap.json'), maxSlots: 2, now: () => clock++ })
  tiny.record('s1', 'w1')
  tiny.record('s2', 'w2')
  tiny.record('s3', 'w3')
  assert.equal(tiny.snapshot().length, 2)
  assert.equal(tiny.get('s1'), undefined)

  assert.match(sessionsPath(), /freetoken[\\/]sessions\.json$/)

  console.log('check-session-store: PASS')
} finally {
  rmSync(tempHome, { recursive: true, force: true })
}
