import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tempHome = mkdtempSync(path.join(tmpdir(), 'ft-context-'))
process.env.DSH_HOME = tempHome

try {
  const { evaluateCredentialAge, credentialAgeMs, describeCredentialAge, DEFAULT_REFRESH_AGE_MS } =
    await import('../lib/transport/credential-age.js')
  const { normalizeConfig } = await import('../lib/config.js')
  const contextFeed = await import('../lib/transport/vendor/context-feed.js')

  // 1) 默认投喂模式必须是 chained（S1.1：请求体从“每轮全量”降为增量）
  const config = normalizeConfig({ enabled: true })
  assert.equal(config.session.contextMode, 'chained', 'default context mode must be chained')

  // 2) 显式 full 仍可回落（可回退性）
  assert.equal(normalizeConfig({ enabled: true, session: { contextMode: 'full' } }).session.contextMode, 'full')
  // 3) 非法值回落默认
  assert.equal(
    normalizeConfig({ enabled: true, session: { contextMode: 'bogus' } }).session.contextMode,
    'chained',
  )

  // 4) 配置真正驱动 vendor 运行时开关（只写配置不写运行时 = 无效）
  contextFeed.resetContextMode()
  assert.equal(contextFeed.currentContextMode(), 'full', 'vendor default stays full until applied')
  contextFeed.applyContextMode(config.session.contextMode)
  assert.equal(contextFeed.currentContextMode(), 'chained')

  // 5) 链式模式不轮换：effectiveReuseLimit 必须是无限（会话长期复用）
  assert.equal(contextFeed.effectiveReuseLimit(20, 'chained'), Number.POSITIVE_INFINITY)
  assert.equal(contextFeed.effectiveReuseLimit(20, 'full'), 20)

  // 6) 全量模式下仍按 reuseTurns 轮换（反向验证：别把两种模式弄混）
  contextFeed.applyContextMode('full')
  assert.equal(contextFeed.effectiveReuseLimit(20, contextFeed.currentContextMode()), 20)
  contextFeed.resetContextMode()

  // 7) 凭证年龄判据：边界、未知、关闭、时钟回拨
  const now = 1_700_000_000_000
  assert.equal(credentialAgeMs(now - 1000, now), 1000)
  assert.equal(credentialAgeMs(undefined, now), null)
  assert.equal(credentialAgeMs(0, now), null)
  assert.equal(credentialAgeMs(now + 60_000, now), 0, 'clock skew must clamp to 0, not negative')

  assert.equal(evaluateCredentialAge({ savedAt: now, now, thresholdMs: DEFAULT_REFRESH_AGE_MS }), 'fresh')
  assert.equal(
    evaluateCredentialAge({ savedAt: now - DEFAULT_REFRESH_AGE_MS + 1, now, thresholdMs: DEFAULT_REFRESH_AGE_MS }),
    'fresh',
  )
  assert.equal(
    evaluateCredentialAge({ savedAt: now - DEFAULT_REFRESH_AGE_MS, now, thresholdMs: DEFAULT_REFRESH_AGE_MS }),
    'due',
  )
  assert.equal(
    evaluateCredentialAge({ savedAt: now - 5 * DEFAULT_REFRESH_AGE_MS, now, thresholdMs: DEFAULT_REFRESH_AGE_MS }),
    'due',
  )
  assert.equal(evaluateCredentialAge({ savedAt: undefined, now, thresholdMs: DEFAULT_REFRESH_AGE_MS }), 'unknown')
  assert.equal(evaluateCredentialAge({ savedAt: now - 10 * DEFAULT_REFRESH_AGE_MS, now, thresholdMs: 0 }), 'disabled')
  assert.equal(
    evaluateCredentialAge({ savedAt: now - 10 * DEFAULT_REFRESH_AGE_MS, now, thresholdMs: -1 }),
    'disabled',
  )

  // 8) 默认阈值必须留出余量：低于实测寿命（约 100 分钟），且不至于每轮都触发
  assert.ok(DEFAULT_REFRESH_AGE_MS < 100 * 60 * 1000, 'threshold must be below the observed token lifetime')
  assert.ok(DEFAULT_REFRESH_AGE_MS >= 30 * 60 * 1000, 'threshold must not be so small that every request refreshes')

  // 9) 描述文本：不含任何凭证内容，只是时长
  assert.match(describeCredentialAge(30_000), /刚刷新|分钟/)
  assert.match(describeCredentialAge(2 * 3600_000 + 30 * 60_000), /2 小时/)
  assert.equal(describeCredentialAge(null), '凭证年龄未知')

  // 10) 反向验证：链式模式下若把 reuseTurns 当轮换依据，会清空用户的会话链
  const chainedLimit = contextFeed.effectiveReuseLimit(1, 'chained')
  assert.equal(Number.isFinite(chainedLimit), false, 'chained must ignore reuseTurns (no rotation)')

  // 11) 【P2-2】用户落盘的面板选择必须**可读**（否则设置页的选择会被配置静默忽略）
  {
    const { writeContextModeSetting, readContextModeSetting, contextModeSettingsPath } = contextFeed
    writeContextModeSetting('full')
    assert.equal(readContextModeSetting(), 'full', 'persisted choice must be readable')
    writeContextModeSetting('chained')
    assert.equal(readContextModeSetting(), 'chained')
    // 落盘文件不存在 ⇒ 回落 undefined（调用方用配置兜底）
    rmSync(contextModeSettingsPath(), { force: true })
    assert.equal(readContextModeSetting(), undefined, 'no persisted choice must fall back to config')
  }

  console.log('check-context-mode: PASS')
} finally {
  rmSync(tempHome, { recursive: true, force: true })
}