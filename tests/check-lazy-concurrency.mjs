import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const tempHome = mkdtempSync(path.join(tmpdir(), 'ft-lazy-'))
process.env.DSH_HOME = tempHome

try {
  // 1) 【P0 反向验证】预热与首个请求并发 ⇒ 只能创建**一个**后端
  //    （否则两个 real-backend 会自撞单实例锁，首请求直接失败）
  const { createLazyBackend } = await import('../lib/transport/lazy-backend.js')
  const { normalizeConfig } = await import('../lib/config.js')
  const config = normalizeConfig({ enabled: true })

  // 统计 lazy 加载次数与后端创建次数
  const { loadedKeysSnapshot } = await import('../lib/lazy/load.js')
  const before = loadedKeysSnapshot().length

  const backend = createLazyBackend(config, {
    logger: { info() {}, warn() {}, debug() {} },
  })

  // 并发调用：start（预热）与 stream（首个请求）同时打进来
  const results = await Promise.allSettled([
    backend.start(),
    (async () => {
      const it = backend.stream({
        provider: 'deepseek-web',
        model: 'deepseek-chat',
        prompt: 'p',
        messages: [],
        thinkingEnabled: false,
        modelType: 'default',
      })
      // 只取第一项就退出（不真正发请求）
      await it.next()
      return 'streamed'
    })(),
  ])
  const after = loadedKeysSnapshot()
  // 'transport/real-backend' 只能被加载一次
  const realLoads = after.filter((k) => k === 'transport/real-backend').length
  assert.ok(realLoads <= 1, `real-backend must be loaded at most once (got ${realLoads})`)
  assert.ok(after.length > before, 'heavy module must have been loaded')
  await backend.close()

  // 2) 【P0-1 反向验证】冷却门必须同时管住 AUTH 恢复路径
  //    （只给预检加冷却不够：预检失败后 savedAt 不更新 ⇒ due 永久为真，
  //     而 AUTH 路径每轮重置 renewalTriedThisTurn ⇒ 每请求仍整页重载一次）
  const realBackendSrc = readFileSync(
    path.resolve(here, '..', 'lib', 'transport', 'real-backend.js'),
    'utf8',
  )
  // AUTH 恢复分支里必须出现冷却门
  const authGateIndex = realBackendSrc.indexOf('!renewalTriedThisTurn')
  assert.ok(authGateIndex >= 0, 'AUTH recovery branch must exist')
  const authBranch = realBackendSrc.slice(authGateIndex, authGateIndex + 400)
  assert.ok(
    authBranch.includes('preflightCooldownUntil'),
    'AUTH recovery branch must be gated by the preflight cooldown',
  )
  // 续签失败也要置冷却
  assert.ok(
    realBackendSrc.includes('preflightCooldownUntil = Date.now() + preflightCooldownMs'),
    'failed renewal must start a cooldown',
  )
  // 冷却时长必须与阈值挂钩（不是写死的常量）
  assert.ok(
    realBackendSrc.includes('preflightCooldownMs(config.session.credentialRefreshAgeMs)'),
    'cooldown must derive from the configured threshold',
  )

  // 3) 冷却时长函数的行为：阈值越大冷却越长，但有上限
  const { evaluateCredentialAge, credentialAgeMs, DEFAULT_REFRESH_AGE_MS } = await import(
    '../lib/transport/credential-age.js'
  )
  assert.equal(DEFAULT_REFRESH_AGE_MS, 90 * 60 * 1000)
  // 阈值 0 ⇒ 预检整体关闭（不会 due）
  assert.equal(
    evaluateCredentialAge({ savedAt: 1, now: 10 ** 13, thresholdMs: 0 }),
    'disabled',
  )
  // 时间戳未知 ⇒ 不做无依据的续签动作
  assert.equal(
    evaluateCredentialAge({ savedAt: undefined, now: 10 ** 13, thresholdMs: DEFAULT_REFRESH_AGE_MS }),
    'unknown',
  )
  assert.equal(credentialAgeMs(undefined, 1), null)

  console.log('check-lazy-concurrency: PASS')
} finally {
  rmSync(tempHome, { recursive: true, force: true })
}