/**
 * 标题本地合成（L1 降请求杠杆）。
 *
 * Harness 的 session-title 调用走 `purpose: 'session-title'`；这里不发网页请求，
 * 直接用首条用户消息生成标题，产出标准 StreamChunk 序列。收益：每个新会话少 1 次网页请求。
 */

const FALLBACK_TITLE = 'Untitled session'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function blockText(block: unknown): string {
  if (!isRecord(block)) return ''
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  return ''
}

function messageText(message: unknown): string {
  if (!isRecord(message)) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(blockText).join(' ')
}

/** 从消息序列里取首条用户消息的文本。 */
export function extractFirstUserText(messages: readonly unknown[] | undefined): string {
  for (const message of messages ?? []) {
    if (!isRecord(message) || message.role !== 'user') continue
    const text = messageText(message).replace(/\s+/g, ' ').trim()
    if (text) return text
  }
  return ''
}

/**
 * 标题请求的真实输入：宿主会把「生成标题」的系统任务 + 一个 JSON 数组
 * （`[{seq, text}]` 的人类消息）一起发过来。直接取首条 user 文本会把
 * 这段指令当成标题（真机 2026-10-20 实测），所以优先解出 JSON 里的第一条 text。
 */
function extractTitleSource(messages: readonly unknown[] | undefined): string {
  const raw = extractFirstUserText(messages)
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1))
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (isRecord(item) && typeof item.text === 'string' && item.text.trim()) {
            return item.text.replace(/\s+/g, ' ').trim()
          }
        }
      }
    } catch {
      // 不是 JSON 就退回原文
    }
  }
  return raw
}

/** 生成标题：首行、去多余空白、按 maxChars 截断（按码点切，避免切裂代理对）。 */
export function deriveTitle(messages: readonly unknown[] | undefined, maxChars: number): string {
  const text = extractTitleSource(messages)
  if (!text) return FALLBACK_TITLE
  const firstLine = text.split(/\r?\n/, 1)[0] ?? text
  const chars = Array.from(firstLine.trim())
  const limit = Math.max(8, Math.min(120, Math.round(maxChars)))
  if (chars.length <= limit) return firstLine.trim()
  return `${chars.slice(0, limit).join('')}…`
}

/** 本地标题的流式分片；零网络、零凭证。 */
export async function* localTitleStream(
  messages: readonly unknown[] | undefined,
  maxChars: number,
): AsyncGenerator<any> {
  const title = deriveTitle(messages, maxChars)
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: title }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }
  yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
