import assert from 'node:assert/strict'
import { normalizeConfig } from '../lib/config.js'
import { createAdapter } from '../lib/adapter/adapter.js'

const config = normalizeConfig({ enabled: true })

// 后端契约（v1.2）：raw WebStreamEvent，不是 Harness chunk。
// 文本以句号收尾：否则会（正确地）触发“句中被截 → 自动续写”，用例只验证单轮翻译。
const events = [
  { kind: 'thinking', text: 'let me think' },
  { kind: 'text', text: 'hi ' },
  { kind: 'text', text: 'there.' },
  { kind: 'finish', reason: 'stop', totalTokens: 5 },
]

function mockBackend() {
  return {
    kind: 'cdp',
    startCalls: 0,
    closeCalls: 0,
    lastRequest: undefined,
    async start() {
      this.startCalls += 1
    },
    async *stream(request) {
      this.lastRequest = request
      yield* events
    },
    async close() {
      this.closeCalls += 1
    },
  }
}

async function collect(iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

const auth = { version: 1, account: { id: 'acct' }, auth: { token: 'token-123' }, savedAt: Date.now() }
const backend = mockBackend()
const narrations = []
const metrics = []
const adapter = createAdapter({
  config,
  getAuth: () => auth,
  backend,
  onNarration: (input) => narrations.push(input),
  onMetric: (name, value) => metrics.push([name, value]),
})

// 元数据
assert.deepEqual(adapter.providerInfo('deepseek-web'), { id: 'deepseek-web', name: 'DeepSeek 网页' })
const models = await adapter.listModels('deepseek-web')
assert.equal(models.length, 2)
assert.deepEqual(models.map((m) => m.id), ['deepseek-chat', 'deepseek-reasoner'])
assert.deepEqual(models[0].inputModalities, ['text', 'image'])
assert.equal(models[0].context.contextWindow, 1048576)
assert.equal(models[0].systemPromptUpdate, 'in-history')
assert.equal(models[0].toolUpdate, 'in-history')

// 扁平重试策略（host 读扁平字段）
const policy = adapter.providerRetryPolicy('deepseek-web')
assert.equal(policy.maxRetries, config.retry.maxRetries)
assert.equal(policy.initialDelayMs, config.retry.baseDelayMs)
assert.equal(policy.maxDelayMs, config.retry.maxDelayMs)
assert.equal(policy.jitterRatio, config.retry.jitterRatio)
assert.equal('backoff' in policy, false)
assert.ok(Array.isArray(policy.retryableCodes) && policy.retryableCodes.includes('TRANSPORT'), 'flat policy must include retryableCodes (host llm-retry reads it)')

// 精确模型解析 + 历史别名回退
assert.equal((await adapter.resolveModel('deepseek-web', 'deepseek-reasoner')).id, 'deepseek-reasoner')
assert.equal((await adapter.resolveModel('deepseek-web', 'deepseek-pro')).id, 'deepseek-chat')
assert.equal((await adapter.resolveModel('deepseek-web', 'unknown-model')).id, 'deepseek-chat')

// prepareCall 绑定同一代模型
const prepared = await adapter.prepareCall('deepseek-web', 'deepseek-reasoner')
assert.equal(prepared.model.id, 'deepseek-reasoner')
assert.equal(typeof prepared.stream, 'function')

// 正常流：raw 事件 → 协议管线 → Harness chunk
const streamed = await collect(
  adapter.stream({
    model: 'deepseek-reasoner',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
    tools: [],
  }),
)
assert.equal(backend.startCalls, 1)
assert.equal(backend.lastRequest.provider, 'deepseek-web')
assert.equal(backend.lastRequest.model, 'deepseek-reasoner')
assert.equal(backend.lastRequest.thinkingEnabled, true)
assert.ok(String(backend.lastRequest.prompt).includes('q'), 'prompt must contain user text')
assert.ok(backend.lastRequest.promptParts, 'promptParts must be passed for chained feeding')
const text = streamed.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
assert.equal(text, 'hi there.')
assert.ok(streamed.some((c) => c.type === 'reasoning-delta' && c.text === 'let me think'))
assert.ok(streamed.some((c) => c.type === 'block-end' && c.block?.type === 'text'))
const finish = streamed.at(-1)
assert.equal(finish.type, 'finish')
assert.equal(finish.reason.kind, 'stop')
assert.ok(streamed.some((c) => c.type === 'usage'))
// narration 解析失败 → 本地模板（零额外请求，不进正文）
assert.ok(narrations.length >= 1)
assert.equal(narrations[0].model, null)
assert.match(String(narrations[0].local), /freetoken/)

// 工具调用：raw 文本里的 JSON 调用被解析成 tool-call chunk，且不泄漏正文
const toolEvents = [
  { kind: 'text', text: 'before ' },
  {
    kind: 'text',
    text: '```dsh-tool\n{"tool_calls":[{"name":"read_file","arguments":{"path":"a.txt"}}]}\n```',
  },
  { kind: 'finish', reason: 'stop' },
]
const toolBackend = {
  kind: 'cdp',
  async start() {},
  async *stream() {
    yield* toolEvents
  },
  async close() {},
}
const toolAdapter = createAdapter({ config, getAuth: () => auth, backend: toolBackend })
const toolChunks = await collect(
  toolAdapter.stream({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'read a.txt' }] }],
    tools: [{ name: 'read_file', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  }),
)
const calls = toolChunks.filter((c) => c.type === 'tool-call-delta')
assert.equal(calls.length, 1, 'one parsed tool call expected')
assert.equal(calls[0].name, 'read_file')
assert.match(calls[0].argumentsDelta, /a\.txt/)
const toolText = toolChunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
assert.equal(toolText.includes('read_file'), false, 'tool JSON must not leak into visible text')
assert.equal(toolChunks.at(-1).type, 'finish')
assert.equal(toolChunks.at(-1).reason.kind, 'tool-calls')

// session-title 本地合成：零后端调用、零凭证、计一次 titleSaved
const titleBackend = mockBackend()
const titleAdapter = createAdapter({ config, getAuth: () => undefined, backend: titleBackend, onMetric: (name, value) => metrics.push([name, value]) })
const titleChunks = await collect(
  titleAdapter.stream({
    model: 'deepseek-chat',
    purpose: 'session-title',
    messages: [{ role: 'user', content: [{ type: 'text', text: '请帮我修复构建失败的问题' }] }],
  }),
)
assert.equal(titleChunks[0].type, 'block-start')
const titleText = titleChunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
assert.ok(titleText.includes('修复构建失败'))
assert.equal(titleChunks.at(-1).type, 'finish')
assert.equal(titleBackend.startCalls, 0, 'local title must not touch the backend')
assert.ok(metrics.some(([name]) => name === 'titleSaved'))

// 未登录：普通调用必须 MISSING_CREDENTIAL
const noAuthAdapter = createAdapter({ config, getAuth: () => undefined, backend: mockBackend() })
let failure
try {
  await collect(noAuthAdapter.stream({ model: 'deepseek-chat', messages: [] }))
} catch (error) {
  failure = error
}
assert.equal(failure?.code, 'MISSING_CREDENTIAL')

// 未登录 + 标题关闭时也必须失败（关闭 localTitle 不得绕过凭证）
const strictConfig = normalizeConfig({ enabled: true, localTitle: { enabled: false } })
const strictAdapter = createAdapter({ config: strictConfig, getAuth: () => undefined, backend: mockBackend() })
let strictFailure
try {
  await collect(strictAdapter.stream({ model: 'deepseek-chat', purpose: 'session-title', messages: [] }))
} catch (error) {
  strictFailure = error
}
assert.equal(strictFailure?.code, 'MISSING_CREDENTIAL')

console.log('check-adapter-contract: PASS')