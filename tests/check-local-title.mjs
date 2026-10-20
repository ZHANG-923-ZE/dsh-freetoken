import assert from 'node:assert/strict'
import { deriveTitle, extractFirstUserText, localTitleStream } from '../lib/adapter/local-title.js'

const messages = [
  { role: 'system', content: [{ type: 'text', text: 'system prompt' }] },
  { role: 'user', content: [{ type: 'text', text: '  帮我排查\n构建失败的问题 ' }] },
]

assert.equal(extractFirstUserText(messages), '帮我排查 构建失败的问题')
assert.ok(deriveTitle(messages, 32).startsWith('帮我排查'))
assert.equal(deriveTitle([], 32), 'Untitled session')

// 截断按码点、避免切裂代理对
const long = [{ role: 'user', content: [{ type: 'text', text: '😀'.repeat(20) }] }]
const title = deriveTitle(long, 8)
assert.equal(Array.from(title).filter((c) => c === '😀').length, 8)

async function collect() {
  const out = []
  for await (const chunk of localTitleStream(messages, 32)) out.push(chunk)
  return out
}

const chunks = await collect()
assert.deepEqual(chunks.map((c) => c.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
assert.equal(chunks[1].text, '帮我排查 构建失败的问题')
assert.equal(chunks[3].usage.outputTokens, 0)
assert.deepEqual(chunks[4].reason, { kind: 'stop' })

console.log('check-local-title: PASS')
