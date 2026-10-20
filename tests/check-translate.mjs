import assert from 'node:assert/strict'
import { buildPrompt, createTranslateState, translateEvent } from '../lib/transport/translate.js'

// prompt 渲染：role 标签 + tool 结果格式
const prompt = buildPrompt({
  system: 'sys',
  messages: [
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
    { role: 'assistant', content: [{ type: 'text', text: '在' }] },
    { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'result' }] },
  ],
})
assert.match(prompt, /\[System\]\nsys/)
assert.match(prompt, /User: 你好/)
assert.match(prompt, /Assistant: 在/)
assert.match(prompt, /\[Tool Result for call-1\]\nresult/)

// 文本翻译：block-start 只出现一次，delta 累积
const state = createTranslateState()
const first = translateEvent(state, { kind: 'text', text: '你' })
const second = translateEvent(state, { kind: 'text', text: '好' })
assert.deepEqual(first.chunks.map((c) => c.type), ['block-start', 'text-delta'])
assert.deepEqual(second.chunks.map((c) => c.type), ['text-delta'])
assert.equal(state.text.text, '你好')

// 思考通道独立块
const reasoning = translateEvent(state, { kind: 'thinking', text: '想' })
assert.equal(reasoning.chunks[0].blockType, 'reasoning')

// finish：先 block-end（两个块）→ usage → finish，且 usage 在 finish 之前
const finished = translateEvent(state, { kind: 'finish', reason: 'FINISHED', totalTokens: 42 })
const types = finished.chunks.map((c) => c.type)
assert.deepEqual(types.slice(-2), ['usage', 'finish'])
assert.ok(types.includes('block-end'))
assert.equal(finished.chunks.at(-1).reason.kind, 'stop')
assert.equal(finished.done, true)

// max-tokens 映射
const maxState = createTranslateState()
const maxed = translateEvent(maxState, { kind: 'finish', reason: 'MAX_TOKENS' })
assert.equal(maxed.chunks.at(-1).reason.kind, 'max-tokens')

// 错误事件按 code 抛出
let failure
try {
  translateEvent(createTranslateState(), { kind: 'error', message: 'boom', code: 'RATE_LIMIT' })
} catch (error) {
  failure = error
}
assert.equal(failure?.code, 'RATE_LIMIT')

console.log('check-translate: PASS')
