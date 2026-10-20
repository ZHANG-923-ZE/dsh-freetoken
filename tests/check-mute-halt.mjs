import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tempHome = mkdtempSync(path.join(tmpdir(), 'ft-halt-'))
process.env.DSH_HOME = tempHome

async function collect(iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

try {
  const { haltPath, writeHalt, readHalt, haltBlocksSend, clearHalt } = await import('../lib/transport/halt.js')
  const { normalizeConfig } = await import('../lib/config.js')
  const { createRhythmController } = await import('../lib/rhythm/controller.js')
  const { createPipeline } = await import('../lib/protocol/pipeline.js')
  const { createAdapter } = await import('../lib/adapter/adapter.js')
  const { createRhythmBackend } = await import('../lib/rhythm/backend.js')

  // 1) 落盘熔断：跨“重启”仍阻止发送；到期自动放行
  const future = Date.now() + 3 * 24 * 3600_000
  writeHalt({ halted: true, reason: 'muted:RATE_LIMIT', mutedUntil: future, at: Date.now() })
  const persisted = readHalt()
  assert.equal(persisted?.halted, true)
  assert.equal(persisted?.mutedUntil, future)
  assert.equal(haltBlocksSend(persisted), true)
  assert.equal(haltBlocksSend({ ...persisted, mutedUntil: Date.now() - 1000 }), false)
  clearHalt()
  assert.equal(readHalt(), undefined)

  // 2) controller：MUTED + 中文日期 → halted + mutedUntil 解析
  const config = normalizeConfig({ enabled: true })
  const patches = []
  const controller = createRhythmController({ config, onStatus: (p) => patches.push(p) })
  const lease = await controller.acquire({ kind: 'chat' })
  const delay = lease.markFailure('MUTED', '网页端已封禁本账号，2026/10/23 13:33:37 解除（约 4301 分钟）', false)
  assert.equal(delay, 0, 'mute must not retry')
  const snap = controller.snapshot()
  assert.equal(snap.retry.attempts, 0)
  assert.ok(patches.some((p) => p.safety?.halted === true), 'safety.halted patch expected')
  assert.ok(patches.some((p) => p.rhythm?.lastBlock?.reason === 'mute-halt'))
  // 熔断后不再放行
  let blocked
  try {
    await controller.acquire({ kind: 'chat' })
  } catch (error) {
    blocked = error
  }
  assert.equal(blocked?.code, 'PERMANENT')
  lease.release()
  controller.dispose()

  // 3) 协议层：mute 文案被分类为 MUTED（不可重试），而不是笼统 TRANSPORT/RATE_LIMIT
  const muteEvents = [
    { kind: 'error', code: 'RATE_LIMIT', message: 'DeepSeek 网页端已封禁本账号，2026/10/23 13:33:37 解除（约 4301 分钟）' },
  ]
  const muteBackend = { kind: 'cdp', async start() {}, async *stream() { yield* muteEvents }, async close() {} }
  const adapter = createAdapter({ config, getAuth: () => ({ version: 1, account: { id: 'a' }, auth: { token: 't' }, savedAt: 1 }), backend: muteBackend })
  let muteError
  try {
    await collect(adapter.stream({ model: 'deepseek-chat', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] }))
  } catch (error) {
    muteError = error
  }
  assert.equal(muteError?.code, 'MUTED')
  assert.equal(muteError?.retryable, false)

  // 4) 落盘熔断时，rhythm backend 直接拒绝且内层 0 调用
  writeHalt({ halted: true, reason: 'muted:RATE_LIMIT', mutedUntil: future, at: Date.now() })
  let innerCalls = 0
  const inner = { kind: 'cdp', async start() {}, async *stream() { innerCalls += 1; yield { kind: 'text', text: 'x' } }, async close() {} }
  const guarded = createRhythmBackend(inner, config)
  let haltedError
  try {
    await collect(guarded.stream({ provider: 'deepseek-web', model: 'deepseek-chat', prompt: 'p', messages: [], thinkingEnabled: false, modelType: 'default' }))
  } catch (error) {
    haltedError = error
  }
  assert.equal(haltedError?.code, 'PERMANENT')
  assert.equal(innerCalls, 0, 'halted state must not reach the network layer')
  await guarded.close()
  clearHalt()

  // 5) 真实链路形态：vendor 抛 RATE_LIMIT + 中文封禁文案 → rhythm backend 必须按 MUTED 熔断
  //    （M26 的真实缺陷：errorCode 把它改写成 AUTH，controller 永远收不到 MUTE ⇒ 不落盘/不停发）
  const guardConfig = normalizeConfig({ enabled: true })
  const realMuteError = {
    code: 'RATE_LIMIT',
    message: 'DeepSeek 网页端已封禁本账号，2026/10/23 13:33:37 解除（约 4301 分钟）',
    retryable: true,
  }
  const muteInner = {
    kind: 'cdp',
    async start() {},
    async *stream() {
      throw realMuteError
    },
    async close() {},
  }
  const mutePatches = []
  const muteGuard = createRhythmBackend(muteInner, guardConfig, { onStatus: (p) => mutePatches.push(p) })
  let realChainError
  try {
    await collect(
      muteGuard.stream({
        provider: 'deepseek-web',
        model: 'deepseek-chat',
        prompt: 'p',
        messages: [],
        thinkingEnabled: false,
        modelType: 'default',
      }),
    )
  } catch (error) {
    realChainError = error
  }
  assert.equal(realChainError, realMuteError, 'original error must be preserved')
  assert.ok(
    mutePatches.some((p) => p.safety?.halted === true),
    'real-chain mute must set safety.halted (halt 落盘由 lifecycle 消费)',
  )
  assert.ok(mutePatches.some((p) => p.rhythm?.lastBlock?.reason === 'mute-halt'))
  assert.ok(
    Number(mutePatches.at(-1)?.safety?.mutedUntil) > Date.now(),
    'mutedUntil must be parsed from the Chinese date text',
  )
  await muteGuard.close()
  clearHalt()

  console.log('check-mute-halt: PASS')
} finally {
  rmSync(tempHome, { recursive: true, force: true })
}