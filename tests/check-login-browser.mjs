import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tempHome = mkdtempSync(path.join(tmpdir(), 'ft-login-'))
process.env.DSH_HOME = tempHome

try {
  const { createRuntime } = await import('../lib/lifecycle.js')
  const { normalizeConfig } = await import('../lib/config.js')
  const { readAuth } = await import('../lib/transport/auth.js')

  const config = normalizeConfig({ enabled: true })
  const ctx = { logger: { info() {}, warn() {} }, llm: { registerAdapter: () => () => {} } }
  const calls = []
  const runtime = createRuntime(ctx, config, {
    browserLogin: async (options) => {
      calls.push(options)
      return {
        ok: true,
        message: 'captured',
        auth: {
          token: 'browser-token-abcdef',
          cookie: 'a=b',
          hifDliq: 'd',
          hifLeim: 'l',
          userAgent: 'UA/1',
          user: { display: '192******27' },
        },
      }
    },
  })
  runtime.start()

  const result = await runtime.ops.login('')
  assert.equal(result.ok, true, result.message)
  assert.equal(calls.length, 1, 'browser login invoked exactly once')
  assert.equal(calls[0].timeoutMs, 300000)
  const stored = readAuth()
  assert.equal(stored?.auth.token, 'browser-token-abcdef')
  assert.equal(stored?.auth.cookie, 'a=b')
  assert.equal(stored?.account.displayName, '192******27')
  assert.equal(runtime.status.snapshot().login.loggedIn, true)
  // 掩码：明文 token 不得出现在返回消息里
  assert.equal(result.message.includes('browser-token-abcdef'), false)

  // 失败路径：不写凭证、报错清晰
  const failed = createRuntime(ctx, config, {
    browserLogin: async () => ({ ok: false, message: 'timeout', reason: 'timeout' }),
  })
  failed.start()
  rmSync(path.join(tempHome, 'freetoken'), { recursive: true, force: true })
  const failure = await failed.ops.login('')
  assert.equal(failure.ok, false)
  assert.match(failure.message, /timeout/)
  assert.equal(readAuth(), undefined)

  await runtime.dispose()
  await failed.dispose()
  console.log('check-login-browser: PASS')
} finally {
  rmSync(tempHome, { recursive: true, force: true })
}
