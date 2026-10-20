import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')

// 隔离 DSH_HOME：enabled 路径会写 device.json，绝不能落到真实用户目录
const tempHome = mkdtempSync(path.join(tmpdir(), 'ft-audit-'))
process.env.DSH_HOME = tempHome

try {
  const { apply } = await import('../lib/index.js')
  const { loadedKeysSnapshot } = await import('../lib/lazy/load.js')

  function fakeCtx() {
    const calls = {
      adapter: 0,
      webServer: 0,
      effects: 0,
      commands: 0,
      disposers: [],
    }
    const ctx = {
      calls,
      logger: { info() {}, warn() {}, debug() {} },
      get(name) {
        if (name !== 'commands') return undefined
        return {
          register() {
            calls.commands += 1
            return () => {}
          },
        }
      },
      effect(fn) {
        calls.effects += 1
        const disposer = fn()
        calls.disposers.push(disposer)
        return disposer
      },
      llm: {
        registerAdapter(providers, adapter) {
          calls.adapter += 1
          assert.deepEqual(providers, ['deepseek-web'])
          assert.equal(typeof adapter.stream, 'function')
          assert.equal(adapter.providerInfo('deepseek-web').id, 'deepseek-web')
          return () => {}
        },
      },
      webServer: {
        register() {
          calls.webServer += 1
          throw new Error('M1: route must not register while disabled')
        },
      },
    }
    return ctx
  }

  // A. 默认配置（enabled 缺省 false）：不得注册 adapter，只允许只读命令
  {
    const ctx = fakeCtx()
    apply(ctx, undefined)
    assert.equal(ctx.calls.adapter, 0, 'no adapter when disabled')
    assert.equal(ctx.calls.webServer, 0, 'no host route when disabled')
    assert.equal(ctx.calls.effects, 1, 'only the command-disposal effect')
    assert.equal(ctx.calls.commands, 1, 'exactly one read-only status command')
    assert.deepEqual(loadedKeysSnapshot(), [], 'no lazy module loaded when disabled')
  }

  // B. statusCommand:false → 完全零注册、零 effect
  {
    const ctx = fakeCtx()
    apply(ctx, { enabled: false, statusCommand: false })
    assert.equal(ctx.calls.adapter, 0)
    assert.equal(ctx.calls.webServer, 0)
    assert.equal(ctx.calls.effects, 0)
    assert.equal(ctx.calls.commands, 0)
  }

  // C. enabled:true → 注册 adapter + host status API（P1/P5），仍不启动浏览器/不加载重模块
  {
    const ctx = fakeCtx()
    apply(ctx, { enabled: true })
    assert.equal(ctx.calls.effects, 3, 'runtime effect + command effect + web API effect')
    assert.equal(ctx.calls.adapter, 1, 'provider registered once when enabled')
    assert.equal(ctx.calls.webServer, 1, 'enabled path registers the read-only host status API')
    assert.deepEqual(loadedKeysSnapshot(), [], 'enabled-idle still loads no heavy module')
    for (const disposer of ctx.calls.disposers) {
      if (typeof disposer === 'function') disposer()
    }
  }

  // C2. 有凭证时预热会加载重模块，但它**不得发生在 apply() 的同步段**
  //     （否则 enabled-idle 的"零重模块"性质在真实环境会被破坏）。
  {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(path.join(tempHome, 'freetoken'), { recursive: true })
    writeFileSync(
      path.join(tempHome, 'freetoken', 'auth.json'),
      JSON.stringify({
        version: 1,
        account: { id: 'default' },
        auth: { token: 'a'.repeat(64) },
        savedAt: Date.now(),
      }),
      'utf8',
    )
    const ctx = fakeCtx()
    apply(ctx, { enabled: true })
    // 同步段：仍未加载任何重模块
    assert.deepEqual(
      loadedKeysSnapshot(),
      [],
      'warm-up must not load heavy modules synchronously inside apply()',
    )
    for (const disposer of ctx.calls.disposers) {
      if (typeof disposer === 'function') disposer()
    }
    // 让出微任务/定时器后再看：此时预热可能已经开始（加载重模块是允许的）。
    await new Promise((resolve) => setTimeout(resolve, 50))
    rmSync(path.join(tempHome, 'freetoken'), { recursive: true, force: true })
  }

  // D. 关闭态产物静态检查：入口不应出现重模块/fetch/浏览器字样
  {
    const index = readFileSync(path.join(packageRoot, 'lib', 'index.js'), 'utf8')
    for (const marker of ['transport/browser', 'transport/webapi', 'transport/pow', 'msedge', 'node:net']) {
      assert.equal(index.includes(marker), false, `lib/index.js must not reference ${marker}`)
    }
    const config = readFileSync(path.join(packageRoot, 'lib', 'config.js'), 'utf8')
    assert.equal(/node:fs|node:net|node:child_process/.test(config), false, 'config.js must stay dependency-free')
  }

  // E. 幂等：重复 apply 不抛错
  {
    const ctx = fakeCtx()
    apply(ctx, { enabled: false, statusCommand: false })
    apply(ctx, { enabled: false, statusCommand: false })
  }

  console.log('check-disabled-audit: PASS')
} finally {
  rmSync(tempHome, { recursive: true, force: true })
}
