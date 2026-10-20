import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tempHome = mkdtempSync(path.join(tmpdir(), 'ft-auth-continuity-'))
process.env.DSH_HOME = tempHome

try {
  const { saveAuth, readAuth } = await import('../lib/transport/auth.js')
  const {
    adoptPageCredential,
    canAttemptAuthRecovery,
    classifyCredentialFailure,
    isSiteOriginUrl,
    toWebAuthShape,
    usableToken,
  } = await import('../lib/transport/credential.js')

  const base = {
    version: 1,
    account: { id: 'default', displayName: 'OLD' },
    auth: {
      token: 'a'.repeat(64),
      cookie: 'ds_session_id=old',
      hifLeim: 'leim-old',
      userAgent: 'UA/OLD',
    },
    userId: 'user-1',
    savedAt: 1_000,
  }

  // 1) 稳定账号身份必须能落盘/读回（vendor 靠它避免“刷新凭证 = 换号”）
  saveAuth({ ...base })
  const stored = readAuth()
  assert.equal(stored?.userId, 'user-1')
  assert.equal(stored?.account.displayName, 'OLD')

  // 2) 页面 token 轮换 → 采纳 token/cookie/身份，刷新 savedAt
  const rotated = adoptPageCredential(stored, {
    token: 'b'.repeat(64),
    cookie: 'ds_session_id=new',
    userId: 'user-1',
    displayName: 'OLD',
  })
  assert.ok(rotated)
  assert.equal(rotated.auth.token, 'b'.repeat(64))
  assert.equal(rotated.auth.cookie, 'ds_session_id=new')
  assert.ok(rotated.savedAt > (stored?.savedAt ?? 0))

  // 3) 反向验证：页面登出（token 空/过短）绝不能覆盖快照
  assert.equal(adoptPageCredential(stored, { token: '' }), undefined)
  assert.equal(adoptPageCredential(stored, { token: 'short' }), undefined)

  // 4) 只补身份：不改“凭证采集时间”
  const identityOnly = adoptPageCredential(stored, { userId: 'user-2', displayName: 'NEW' })
  assert.ok(identityOnly)
  assert.equal(identityOnly.userId, 'user-2')
  assert.equal(identityOnly.account.displayName, 'NEW')
  assert.equal(identityOnly.savedAt, stored?.savedAt)

  // 5) 完全无变化 → undefined（调用方不写盘）
  assert.equal(
    adoptPageCredential(stored, {
      token: stored?.auth.token,
      cookie: stored?.auth.cookie,
      userId: 'user-1',
      displayName: 'OLD',
    }),
    undefined,
  )

  // 6) 失败分类：授权类（必须重登） vs 瞬时（不该报断线）
  for (const text of [
    'HTTP 401: Authorization Failed (invalid token)',
    'authorization failed',
    '登录态已过期',
    'missing credential',
  ]) {
    assert.equal(classifyCredentialFailure(text), 'auth', text)
  }
  for (const text of [
    'fetch failed',
    'users/current HTTP 500',
    'users/current HTTP 429',
    'The operation was aborted due to timeout',
    '',
  ]) {
    assert.equal(classifyCredentialFailure(text), 'transient', text)
  }

  // 7) AUTH 自动重试门槛：只有第一次尝试且未产出正文/思考内容
  assert.equal(canAttemptAuthRecovery({ attempt: 0, contentEmitted: false }), true)
  assert.equal(canAttemptAuthRecovery({ attempt: 1, contentEmitted: false }), false)
  assert.equal(canAttemptAuthRecovery({ attempt: 0, contentEmitted: true }), false)

  // 8) vendor WebAuth 形状：稳定身份与指纹必须带过去
  const webAuth = toWebAuthShape(stored)
  assert.equal(webAuth.token, 'a'.repeat(64))
  assert.equal(webAuth.user?.id, 'user-1')
  assert.equal(webAuth.user?.display, 'OLD')
  assert.equal(webAuth.unverified, true)
  assert.equal(webAuth.userAgent, 'UA/OLD')

  // 9) 站点 origin / token 下限
  assert.equal(isSiteOriginUrl('https://chat.deepseek.com/a/chat'), true)
  assert.equal(isSiteOriginUrl('https://chat.deepseek.com.evil.example/'), false)
  assert.equal(isSiteOriginUrl('about:blank'), false)
  assert.equal(usableToken('  ' + 'c'.repeat(64) + ' '), 'c'.repeat(64))
  assert.equal(usableToken('short'), '')

  // 10) 传输层 UA：必须真的进浏览器启动参数（否则 headless 用 HeadlessChrome UA）
  const transport = await import('../lib/transport/vendor/browser-transport.js')
  assert.equal(transport.currentTransportUserAgent(), undefined)
  transport.setTransportUserAgent('UA/LOGIN')
  assert.equal(transport.currentTransportUserAgent(), 'UA/LOGIN')
  assert.ok(
    transport.transportBrowserArgs('C:\\tmp\\profile', 'UA/LOGIN').includes('--user-agent=UA/LOGIN'),
    'transport browser must be launched with the captured UA',
  )
  assert.ok(
    transport
      .transportBrowserArgs('C:\\tmp\\profile')
      .every((arg) => !String(arg).startsWith('--user-agent=')),
    'no UA argument when none is known',
  )
  transport.setTransportUserAgent(undefined)
  assert.equal(transport.currentTransportUserAgent(), undefined)

  // 10b) probeAuth：HTTP 200 的“授权失败信封”必须判失败；数字 id / 其它形态必须回填身份
  const { probeAuth } = await import('../lib/transport/probe.js')
  const probeCredential = {
    version: 1,
    account: { id: 'default' },
    auth: { token: 'f'.repeat(64) },
    savedAt: Date.now(),
  }
  const jsonResponse = (body) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  const envelope = await probeAuth(probeCredential, async () =>
    jsonResponse({ code: 0, data: { biz_code: 40003, biz_msg: 'Authorization Failed (invalid token)' } }),
  )
  assert.equal(envelope.ok, false, '200 + authorization-failure envelope must not pass as ok')
  assert.match(String(envelope.error), /40003|authorization failed/i)

  const numericId = await probeAuth(probeCredential, async () =>
    jsonResponse({ code: 0, data: { biz_data: { user: { id: 12345, display_name: 'NUM' } } } }),
  )
  assert.equal(numericId.ok, true, numericId.error)
  assert.equal(numericId.user?.id, '12345', 'numeric user id must be normalized to string')
  assert.equal(numericId.user?.display, 'NUM')

  const altShape = await probeAuth(probeCredential, async () =>
    jsonResponse({ code: 0, data: { user: { user_id: 'u-alt', name: 'ALT' } } }),
  )
  assert.equal(altShape.ok, true, altShape.error)
  assert.equal(altShape.user?.id, 'u-alt')
  assert.equal(altShape.user?.display, 'ALT')

  // 11) 生命周期：登录/探活把稳定身份落盘，状态区分“凭证失效”与“网络抖动”
  const { createRuntime } = await import('../lib/lifecycle.js')
  const { normalizeConfig } = await import('../lib/config.js')
  const config = normalizeConfig({ enabled: true })
  const ctx = {
    logger: { info() {}, warn() {} },
    llm: { registerAdapter: () => () => {} },
  }
  let probeResult = { ok: true, user: { id: 'user-B', display: 'B' } }
  let probeMode = 'ok'
  let resetCalls = 0
  const backend = {
    kind: 'cdp',
    async start() {},
    async *stream() {},
    async close() {},
    async probe() {
      if (probeMode === 'throw') throw new Error('browser missing')
      return probeResult
    },
    resetCredentialSession() {
      resetCalls += 1
    },
  }

  // 11a 浏览器捕获路径：身份从捕获结果直接落盘；测试注入不得碰真实传输层
  rmSync(path.join(tempHome, 'freetoken'), { recursive: true, force: true })
  const capturedRuntime = createRuntime(ctx, config, {
    backend,
    browserLogin: async () => ({
      ok: true,
      message: 'captured',
      auth: {
        token: 'd'.repeat(64),
        userAgent: 'UA/CAP',
        user: { id: 'user-A', display: 'A' },
      },
    }),
  })
  capturedRuntime.start()
  const loginResult = await capturedRuntime.ops.login('')
  assert.equal(loginResult.ok, true, loginResult.message)
  assert.equal(readAuth()?.userId, 'user-A')
  assert.equal(readAuth()?.account.displayName, 'A')
  assert.equal(resetCalls, 0, 'injected browser login must not touch the real transport session')

  // 11b 手工 token 登录：走 probe 回填身份，并清掉页面旧凭证的登录态
  rmSync(path.join(tempHome, 'freetoken'), { recursive: true, force: true })
  resetCalls = 0
  const tokenRuntime = createRuntime(ctx, config, { backend })
  tokenRuntime.start()
  const tokenLogin = await tokenRuntime.ops.login('e'.repeat(64))
  assert.equal(tokenLogin.ok, true, tokenLogin.message)
  assert.equal(resetCalls, 1, 'new credential must invalidate the transport page session')
  assert.equal(readAuth()?.userId, 'user-B')
  assert.equal(readAuth()?.account.displayName, 'B')
  assert.equal(tokenRuntime.status.snapshot().login.loggedIn, true)

  // 11c 瞬时失败：保留登录态，只记录错误（不能误报“登录断了”）
  probeResult = { ok: false, error: 'fetch failed' }
  const transient = await tokenRuntime.ops.probe()
  assert.equal(transient.ok, false)
  assert.equal(
    tokenRuntime.status.snapshot().login.loggedIn,
    true,
    'transient probe failure must not flip loggedIn',
  )
  assert.match(String(tokenRuntime.status.snapshot().login.lastError), /fetch failed/)

  // 11d 探活器自身抛错：同样不是凭证失效
  probeMode = 'throw'
  const unavailable = await tokenRuntime.ops.probe()
  assert.equal(unavailable.ok, false)
  assert.equal(tokenRuntime.status.snapshot().login.loggedIn, true)
  assert.match(String(tokenRuntime.status.snapshot().login.lastError), /probe unavailable/)

  // 11e 授权失败：才降级为未登录；凭证与身份不删
  probeMode = 'ok'
  probeResult = { ok: false, error: 'HTTP 401: Authorization Failed (invalid token)' }
  const authFailure = await tokenRuntime.ops.probe()
  assert.equal(authFailure.ok, false)
  assert.equal(tokenRuntime.status.snapshot().login.loggedIn, false)
  assert.equal(tokenRuntime.status.snapshot().lastFailure?.code, 'AUTH')
  assert.equal(readAuth()?.userId, 'user-B', 'probe failure must not clear credential/identity')

  // 11f 恢复后状态回正 + 身份仍在
  probeResult = { ok: true, user: { id: 'user-B', display: 'B' } }
  const recovered = await tokenRuntime.ops.probe()
  assert.equal(recovered.ok, true, recovered.message)
  assert.equal(tokenRuntime.status.snapshot().login.loggedIn, true)
  assert.equal(tokenRuntime.status.snapshot().login.lastError, null)
  assert.equal(readAuth()?.userId, 'user-B')

  await capturedRuntime.dispose()
  await tokenRuntime.dispose()
  console.log('check-auth-continuity: PASS')
} finally {
  rmSync(tempHome, { recursive: true, force: true })
}