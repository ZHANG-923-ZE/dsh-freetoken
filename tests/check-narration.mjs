import assert from 'node:assert/strict'
import { splitNarration, localNarration } from '../lib/protocol/narration.js'

// 同响应拆分：narration 与正文分离
{
  const split = splitNarration('<narration>done: 读了配置; next: 改代码</narration>\n正文内容')
  assert.equal(split.narration, 'done: 读了配置; next: 改代码')
  assert.equal(split.text, '正文内容')
}

// 无 narration：正文原样，不产生内容
{
  const split = splitNarration('只有正文')
  assert.equal(split.narration, null)
  assert.equal(split.text, '只有正文')
}

// 空 narration 视为没有
{
  assert.equal(splitNarration('<narration>   </narration>x').narration, null)
}

// 未闭合：不误吞正文，narration=null（调用方降级本地模板）
{
  const split = splitNarration('<narration>未闭合\ntext')
  assert.equal(split.narration, null)
  assert.ok(split.text.includes('未闭合'))
}

// 本地模板：只描述提供的字段
assert.match(localNarration({ mergedCalls: 3, parseFailures: 1, retryPlan: '重试 1 项' }), /本轮合并 3 个调用/)
assert.match(localNarration({ mergedCalls: 3 }), /重试 1 项|^\[freetoken\]/)
assert.match(localNarration({ queuePending: 2, etaMs: 5000 }), /队列待发 2 项，预计 5s 后发送/)
assert.equal(localNarration({}), '[freetoken] 空闲')

console.log('check-narration: PASS')
