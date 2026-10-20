import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tempHome = mkdtempSync(path.join(tmpdir(), 'ft-cmd-'))
process.env.DSH_HOME = tempHome

const originalFetch = globalThis.fetch

function ctxWithCommands() {
  const state = { handler: undefined, adapter: 0 }
  const commands = {
    register(definition) {
      state.handler = definition.handler
      return () => {}
    },
  }
  const ctx = {
    state,
    logger: { info() {}, warn() {}, debug() {} },
    get(name) {
      return name === 'commands' ? commands : undefined
    },
    effect(fn) {
      return fn()
    },
    llm: {
      registerAdapter() {
        state.adapter += 1
        return () => {}
      },
    },
  }
  return ctx
}

try {
  const { apply } = await import('../lib/index.js')
  const { readAuth } = await import('../lib/transport/auth.js')

  // 测试注入：真实后端会懒启动 Edge；命令面测试只关心状态流转，用假后端。
  const mockBackend = () => ({
    kind: 'cdp',
    async start() {},
    async *stream() {},
    async probe() {
      return { ok: true, user: { id: 'u1', display: 'tester' } }
    },
    async close() {},
  })

  // 启用态：login/probe/logout 走真实存储 + 可注入后端
  const ctx = ctxWithCommands()
  apply(ctx, { enabled: true }, { backend: mockBackend() })
  const handler = ctx.state.handler
  assert.equal(typeof handler, 'function')
  assert.equal(ctx.state.adapter, 1)
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ code: 0, data: { biz_data: { user: { id: 'u1', display_name: 'tester' } } } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )

  const login = await handler({ rawInput: 'login tok-abcdef123456' })
  assert.equal(login.kind, 'success', login.text)
  assert.equal(readAuth()?.auth.token, 'tok-abcdef123456')
  assert.match(login.text, /tok-abcdef123456|tok-\*\*\*\*3456/)

  const status = await handler({ rawInput: 'status' })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /login: logged-in/)

  const probe = await handler({ rawInput: 'probe' })
  assert.equal(probe.kind, 'success', probe.text)

  const logout = await handler({ rawInput: 'logout' })
  assert.equal(logout.kind, 'success')
  assert.equal(readAuth(), undefined)

  const probeAfterLogout = await handler({ rawInput: 'probe' })
  assert.equal(probeAfterLogout.kind, 'error')

  // 关闭态：命令存在，但写操作被拒绝
  const disabledCtx = ctxWithCommands()
  apply(disabledCtx, { enabled: false })
  const disabledHandler = disabledCtx.state.handler
  const disabledLogin = await disabledHandler({ rawInput: 'login tok-x' })
  assert.equal(disabledLogin.kind, 'error')
  assert.match(disabledLogin.text, /needs the plugin enabled/)
  assert.equal(readAuth(), undefined)

  console.log('check-commands: PASS')
} finally {
  globalThis.fetch = originalFetch
  rmSync(tempHome, { recursive: true, force: true })
}

