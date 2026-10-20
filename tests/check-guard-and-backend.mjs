import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeConfig } from '../lib/config.js'
import { looksLikeProbingQuestion, NarrationDeduper } from '../lib/protocol/content-guard.js'
import { createAdapter } from '../lib/adapter/adapter.js'

const tempHome = mkdtempSync(path.join(tmpdir(), 'ft-guard-'))
process.env.DSH_HOME = tempHome

async function collect(iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

try {
  // ── M26/R17：探接口式问法识别（只提示，不改写用户输入） ──
  assert.equal(looksLikeProbingQuestion('你是什么模型？'), true)
  assert.equal(looksLikeProbingQuestion('what model are you'), true)
  assert.equal(looksLikeProbingQuestion('帮我修复这个构建失败'), false)

  // ── M26/D27：narration 去重窗口 ──
  {
    let now = 1000
    const dedupe = new NarrationDeduper({ windowMs: 90000, maxRepeats: 2, now: () => now })
    assert.deepEqual(dedupe.record('done: A; next: B'), { text: 'done: A; next: B', suppressed: false })
    assert.deepEqual(dedupe.record('done: A; next: B'), { text: 'done: A; next: B', suppressed: false })
    assert.deepEqual(dedupe.record('done: A; next: B'), { text: null, suppressed: true })
    assert.equal(dedupe.suppressedCount, 1)
    now += 90001
    assert.equal(dedupe.record('done: A; next: B').suppressed, false, 'window expiry must allow the text again')
  }

  // ── M13/D12：narration 同响应拆分 → reasoning，不进正文 ──
  {
    // 关掉自动续写：本用例只验证拆分语义，避免 fixture 的“句尾无标点”触发续写轮。
    const config = normalizeConfig({ enabled: true, protocol: { autoContinue: false } })
    const events = [
      { kind: 'text', text: 'hello ' },
      { kind: 'text', text: '<narration>done: 读了文件; next: 修改它</narration>' },
      { kind: 'finish', reason: 'stop' },
    ]
    const narrations = []
    const backend = {
      kind: 'cdp',
      async start() {},
      async *stream() {
        yield* events
      },
      async close() {},
    }
    const adapter = createAdapter({
      config,
      getAuth: () => ({ version: 1, account: { id: 'a' }, auth: { token: 't' }, savedAt: 1 }),
      backend,
      onNarration: (input) => narrations.push(input),
    })
    const chunks = await collect(
      adapter.stream({ model: 'deepseek-chat', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] }),
    )
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    assert.equal(text, 'hello ', 'narration block must not leak into visible text')
    const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
    assert.match(reasoning, /读了文件/)
    assert.equal(narrations.length, 1)
    assert.equal(narrations[0].model, 'done: 读了文件; next: 修改它')
    assert.equal(narrations[0].local, null, 'model narration must not trigger the local fallback')
  }

  // ── M24/R14：没有浏览器 → POW_REQUIRES_BROWSER，宿主零出网 ──
  {
    process.env.DSH_NO_BROWSER_TRANSPORT = '1'
    const originalFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = async (...args) => {
      fetchCalls += 1
      return originalFetch(...args)
    }
    const { createRealBackend } = await import('../lib/transport/real-backend.js')
    try {
      const config = normalizeConfig({ enabled: true, backend: 'cdp' })
      const backend = createRealBackend(config)
      let failure
      try {
        await backend.start()
      } catch (error) {
        failure = error
      }
      assert.equal(failure?.code, 'POW_REQUIRES_BROWSER')
      assert.equal(fetchCalls, 0, 'no Node-side egress when the browser is unavailable')
      // M25：接口形状
      assert.equal(backend.kind, 'cdp')
      assert.equal(typeof backend.start, 'function')
      assert.equal(typeof backend.stream, 'function')
      assert.equal(typeof backend.close, 'function')
      await backend.close()

      // M25：dom 后端明确报错（不静默降级）
      const dom = createRealBackend(normalizeConfig({ enabled: true, backend: 'dom' }))
      let domFailure
      try {
        await dom.start()
      } catch (error) {
        domFailure = error
      }
      assert.equal(domFailure?.code, 'BACKEND_NOT_READY')
      assert.match(String(domFailure?.message), /DOM backend/i)
    } finally {
      globalThis.fetch = originalFetch
      delete process.env.DSH_NO_BROWSER_TRANSPORT
    }
  }

  console.log('check-guard-and-backend: PASS')
} finally {
  rmSync(tempHome, { recursive: true, force: true })
}