/**
 * 纯函数传输层：GenerateOptions → 网页 prompt；WebStreamEvent → StreamChunk。
 * 不 import 任何 vendor/网络模块，便于离线单测。
 */

import { FreetokenError } from '../adapter/errors.js'

export interface PromptRequest {
  system?: string
  messages: readonly any[]
}

function flatten(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) =>
      block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string'
        ? block.text
        : '',
    )
    .join('')
}

/** 把 Harness 消息渲染成网页端单段 prompt（P1 无工具目录；P3 再接协议层）。 */
export function buildPrompt(request: PromptRequest): string {
  const parts: string[] = []
  if (request.system?.trim()) parts.push(`[System]\n${request.system.trim()}`)
  for (const message of request.messages ?? []) {
    const text = flatten(message?.content).trim()
    if (!text) continue
    switch (message?.role) {
      case 'system':
        parts.push(`[System]\n${text}`)
        break
      case 'user':
        parts.push(`User: ${text}`)
        break
      case 'assistant':
        parts.push(`Assistant: ${text}`)
        break
      case 'tool':
        parts.push(`[Tool Result for ${String(message?.toolCallId ?? '')}]\n${text}`)
        break
      case 'developer':
        parts.push(`[Developer]\n${text}`)
        break
      default:
        parts.push(text)
    }
  }
  return parts.join('\n\n')
}

export interface TranslateState {
  nextIndex: number
  text?: { index: number; text: string }
  reasoning?: { index: number; text: string }
  outputChars: number
}

export function createTranslateState(): TranslateState {
  return { nextIndex: 0, outputChars: 0 }
}

function openText(state: TranslateState): { index: number; text: string } {
  state.text ??= { index: state.nextIndex++, text: '' }
  return state.text
}

function openReasoning(state: TranslateState): { index: number; text: string } {
  state.reasoning ??= { index: state.nextIndex++, text: '' }
  return state.reasoning
}

function finishReason(reason: string | undefined): any {
  const text = String(reason ?? '').toUpperCase()
  if (text.includes('MAX') || text.includes('TOKEN')) return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

/** 翻译一条网页 SSE 事件；返回要 yield 的 chunk 与是否终止。 */
export function translateEvent(
  state: TranslateState,
  event: any,
): { chunks: any[]; done: boolean } {
  const chunks: any[] = []
  if (event?.kind === 'thinking') {
    const block = openReasoning(state)
    block.text += event.text
    if (block.text === event.text) chunks.push({ type: 'block-start', index: block.index, blockType: 'reasoning' })
    chunks.push({ type: 'reasoning-delta', index: block.index, text: event.text })
    return { chunks, done: false }
  }
  if (event?.kind === 'text') {
    const block = openText(state)
    block.text += event.text
    state.outputChars += event.text.length
    if (block.text === event.text) chunks.push({ type: 'block-start', index: block.index, blockType: 'text' })
    chunks.push({ type: 'text-delta', index: block.index, text: event.text })
    return { chunks, done: false }
  }
  if (event?.kind === 'error') {
    throw new FreetokenError(
      (event.code as any) === 'RATE_LIMIT' ? 'RATE_LIMIT' : 'TRANSPORT',
      `freetoken: DeepSeek web error: ${String(event.message ?? 'unknown')}`,
      { retryable: true },
    )
  }
  if (event?.kind === 'finish') {
    if (state.reasoning) {
      chunks.push({
        type: 'block-end',
        index: state.reasoning.index,
        block: { type: 'reasoning', text: state.reasoning.text },
      })
    }
    if (state.text) {
      chunks.push({ type: 'block-end', index: state.text.index, block: { type: 'text', text: state.text.text } })
    }
    const outputTokens = Math.max(1, Math.ceil(state.outputChars / 4))
    chunks.push({
      type: 'usage',
      usage: {
        inputTokens: 0,
        outputTokens,
        ...(typeof event.totalTokens === 'number' ? { totalTokens: event.totalTokens } : {}),
      },
    })
    chunks.push({ type: 'finish', reason: finishReason(event.reason) })
    return { chunks, done: true }
  }
  return { chunks, done: false }
}
