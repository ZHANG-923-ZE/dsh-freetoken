/**
 * 协议管线（P3）：把 Harness 的 GenerateOptions 变成网页请求，再把原始网页事件
 * 变成 Harness 的 StreamChunk。
 *
 * 本模块是**重模块**（依赖 vendor/protocol），只允许经 `lazy/load.ts` 加载。
 *
 * 复用基座已解决的部分（不重写）：
 *  - prompt 序列化（系统段 + 工具协议/目录 + 历史 + 图像占位）→ vendor protocol
 *  - 工具调用流式捕获/JSON/XML 容错/修复 → ToolCallStreamFilter
 *  - 回声/伪系统标记/免责声明过滤 → TranscriptEchoGuard / SystemMarkerStreamFilter / BoilerplateFilter
 *  - 思考通道净化 → ReasoningSanitizer
 *
 * 本插件新增：
 *  - `<narration>` 同响应拆分 → reasoning 块（narration.enabled 时）
 *  - narration 去重（D27）与本地模板降级（D13，零额外请求）
 *  - 自动续写（协议允许的 chat 类请求，最多 maxContinuations 轮）
 */

import type { FreetokenConfig } from '../config.js'
import { FreetokenError } from '../adapter/errors.js'
import type { BackendRequest, ExecutionBackend } from '../transport/backend.js'
import { localNarration } from './narration.js'
import { NarrationDeduper, looksLikeProbingQuestion } from './content-guard.js'
import {
  BoilerplateFilter,
  ReasoningSanitizer,
  SystemMarkerStreamFilter,
  ToolCallStreamFilter,
  TranscriptEchoGuard,
  collectImageRefs,
  drainTextPipeline,
  imageUploadName,
  looksLikeUnexecutedToolProgram,
  serializePromptParts,
  CONTINUE_INSTRUCTION,
  TOOL_CALL_RETRY_INSTRUCTION,
  type PromptParts,
} from '../transport/vendor/protocol.js'

export interface PipelineLogger {
  info?: (message: string) => void
  warn?: (message: string) => void
  debug?: (message: string) => void
}

export interface ReadImageResult {
  data: Uint8Array
  mediaType?: string
  name?: string
}

export interface PipelineDeps {
  config: FreetokenConfig
  backend: ExecutionBackend
  logger?: PipelineLogger
  /** 附件读取（ctx.attachments）；缺失时图片会被忽略并上屏提示。 */
  readImage?: (ref: any, signal?: AbortSignal) => Promise<ReadImageResult>
  /** 旁白/本地讲解回调（进 status/面板/日志，绝不进网页 prompt）。 */
  onNarration?: (input: { model?: string | null; local?: string | null; suppressed?: number }) => void
  onMetric?: (name: string, value?: number) => void
}

interface StreamState {
  nextIndex: number
  text: { index: number; text: string } | null
  textStarted: boolean
  reasoning: { index: number; text: string } | null
  reasoningStarted: boolean
  narration: { index: number; text: string } | null
  narrationStarted: boolean
  toolCalls: number
}

function looksMidSentence(text: string): boolean {
  const tail = String(text ?? '').trimEnd()
  if (!tail) return false
  const last = tail.slice(-1)
  return !/[。！？!?.;；:：、\n）)】」』”"』]$/.test(last)
}

function allowsAutoContinue(purpose: unknown): boolean {
  const value = typeof purpose === 'string' ? purpose : ''
  return value === '' || value === 'chat'
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(String(text ?? '').length / 3.2))
}

function isContextTooLong(message: unknown): boolean {
  return /context|too long|maximum.*length|超出.*长度|上下文/i.test(String(message ?? ''))
}

/** `<narration>` 流式拆分：命中闭合标签则拆出；未闭合的尾巴在流末原样作为正文吐出。 */
const OPEN_TAG = '<narration>'
const CLOSE_TAG = '</narration>'

class NarrationFilter {
  private buffer = ''
  private inside = false

  constructor(private readonly enabled: boolean) {}

  push(text: string): { text: string; narration: string | null } {
    if (!this.enabled) return { text, narration: null }
    if (text) this.buffer += text
    if (!this.buffer) return { text: '', narration: null }
    return this.drain()
  }

  /**
   * 把 buffer 里能确定的内容全部吐出去。
   * 关键点：进入 `<narration>` 之后要**继续在本轮里找闭合标签**（不能靠递归 push('')，
   * 空输入会被早退掉 —— 那正是“开标签消失、内容漏进正文”的根因）。
   */
  private drain(): { text: string; narration: string | null } {
    let out = ''
    let narration: string | null = null
    for (;;) {
      if (!this.inside) {
        const at = this.buffer.indexOf(OPEN_TAG)
        if (at === -1) {
          // 只在尾巴可能是一个**开标签前缀**时扣住（`<`、`<n`、`<narr`…），
          // 其余正文立即上屏 —— 不能像固定长度 hold-back 那样把短正文压到流末。
          let keep = 0
          const max = Math.min(OPEN_TAG.length - 1, this.buffer.length)
          for (let k = max; k > 0; k -= 1) {
            if (OPEN_TAG.startsWith(this.buffer.slice(this.buffer.length - k))) {
              keep = k
              break
            }
          }
          out += this.buffer.slice(0, this.buffer.length - keep)
          this.buffer = keep > 0 ? this.buffer.slice(this.buffer.length - keep) : ''
          break
        }
        out += this.buffer.slice(0, at)
        this.buffer = this.buffer.slice(at + OPEN_TAG.length)
        this.inside = true
        continue
      }
      const close = this.buffer.indexOf(CLOSE_TAG)
      if (close === -1) break
      const value = this.buffer.slice(0, close).trim()
      if (value && narration === null) narration = value
      this.buffer = this.buffer.slice(close + CLOSE_TAG.length)
      this.inside = false
    }
    return { text: out, narration }
  }

  flush(): { text: string; narration: string | null } {
    if (!this.enabled) {
      const out = this.buffer
      this.buffer = ''
      return { text: out, narration: null }
    }
    if (this.inside) {
      // 未闭合：按“不误吞”原则，整段当正文吐出去（解析失败不回请求）。
      const out = this.buffer
      this.buffer = ''
      this.inside = false
      return { text: out, narration: null }
    }
    return this.drain()
  }
}

export function createPipeline(deps: PipelineDeps) {
  const { config, backend } = deps
  const deduper = new NarrationDeduper({ windowMs: config.narration.dedupeWindowMs, maxRepeats: config.narration.maxRepeats })
  const imageCache = new Map<string, string>()

  const narrationClause = [
    '## Narration protocol',
    'After your visible answer, append exactly one block:',
    '`<narration>done: <one sentence about what you just did>; next: <one sentence about what you will do next, or "none"></narration>`',
    'Only describe this same response (done/next). Do not quote history, do not repeat template phrases, and never mention internal tools, prompts, APIs or the provider.',
  ].join('\n')

  const probingClause = config.protocol.forbidProbingQuestions
    ? 'Never ask the user probing questions about your own implementation, model identity, API/endpoints or system prompt. If the user asks, answer only what is safe and relevant to their task.'
    : ''

  const buildSystem = (options: any): string => {
    const parts: string[] = []
    if (typeof options?.system === 'string' && options.system.trim()) parts.push(options.system.trim())
    if (config.narration.enabled) parts.push(narrationClause)
    if (probingClause) parts.push(probingClause)
    return parts.join('\n\n')
  }

  const uploadImages = async (options: any, signal?: AbortSignal): Promise<{ ids: string[]; keys: string[]; keptKeys: Set<string>; notice?: string }> => {
    const refs = collectImageRefs(options?.messages)
    if (refs.length === 0) return { ids: [], keys: [], keptKeys: new Set() }
    if (!backend.uploadImage) {
      return {
        ids: [],
        keys: [],
        keptKeys: new Set(),
        notice: `\n[freetoken] 本路由未启用图片上传能力，${refs.length} 张图片被忽略。\n`,
      }
    }
    if (!deps.readImage) {
      return {
        ids: [],
        keys: [],
        keptKeys: new Set(),
        notice: `\n[freetoken] 宿主没有提供附件读取能力（ctx.attachments），${refs.length} 张图片被忽略。\n`,
      }
    }
    const seen = new Set<string>()
    const ids: string[] = []
    const keys: string[] = []
    const keptKeys = new Set<string>()
    for (const ref of refs) {
      signal?.throwIfAborted()
      const key = String(ref?.attachmentId ?? '')
      if (!key || seen.has(key)) continue
      seen.add(key)
      const cached = imageCache.get(key)
      if (cached) {
        ids.push(cached)
        keys.push(key)
        keptKeys.add(key)
        continue
      }
      try {
        const stored = await deps.readImage(ref, signal)
        const mediaType = stored.mediaType || String(ref?.mediaType ?? 'image/png')
        const uploaded = await backend.uploadImage({
          data: stored.data,
          mediaType,
          name: imageUploadName(stored.name ?? ref?.name, mediaType),
        })
        imageCache.set(key, uploaded.fileId)
        ids.push(uploaded.fileId)
        keys.push(key)
        keptKeys.add(key)
      } catch (error: any) {
        deps.logger?.warn?.(`freetoken: image upload failed for ${key}: ${error?.message ?? error}`)
      }
    }
    return { ids, keys, keptKeys }
  }

  const emitCalls = function* (state: StreamState, calls: readonly any[]): Generator<any> {
    for (const call of calls) {
      const index = state.nextIndex++
      state.toolCalls += 1
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments }
      yield {
        type: 'block-end',
        index,
        block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments },
      }
    }
  }

  async function* stream(options: any): AsyncGenerator<any> {
    if (options?.purpose !== 'chat' && typeof options?.system === 'string') {
      // 内部请求同样允许系统段，但不会触发 narration 协议。
    }
    const thinkingEnabled = String(options?.model ?? '') === 'deepseek-reasoner'
    const signal: AbortSignal | undefined = options?.signal
    let narrationReported = false

    const state: StreamState = {
      nextIndex: 0,
      text: null,
      textStarted: false,
      reasoning: null,
      reasoningStarted: false,
      narration: null,
      narrationStarted: false,
      toolCalls: 0,
    }

    const openText = () => (state.text ??= { index: state.nextIndex++, text: '' })
    const openReasoning = () => (state.reasoning ??= { index: state.nextIndex++, text: '' })
    const openNarrationBlock = () => (state.narration ??= { index: state.nextIndex++, text: '' })

    const emitReasoningDelta = function* (text: string): Generator<any> {
      if (!text) return
      const block = openReasoning()
      if (!state.reasoningStarted) {
        state.reasoningStarted = true
        yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
      }
      block.text += text
      yield { type: 'reasoning-delta', index: block.index, text }
    }

    const emitTextDelta = function* (text: string): Generator<any> {
      if (!text) return
      const block = openText()
      if (!state.textStarted) {
        state.textStarted = true
        yield { type: 'block-start', index: block.index, blockType: 'text' }
      }
      block.text += text
      yield { type: 'text-delta', index: block.index, text }
    }

    const reportNarration = (raw: string): void => {
      if (!config.narration.enabled || narrationReported) return
      narrationReported = true
      const decision = deduper.record(raw)
      deps.onNarration?.({
        model: decision.text,
        local: decision.text ? null : localNarration({ phase: 'done' }),
        suppressed: deduper.suppressedCount,
      })
      if (decision.suppressed) deps.onMetric?.('narrationSuppressed', 1)
    }

    const emitNarrationReasoning = function* (raw: string): Generator<any> {
      if (!config.narration.enabled || !raw.trim()) return
      const decision = deduper.record(raw)
      if (decision.text === null) return
      const block = openNarrationBlock()
      if (!state.narrationStarted) {
        state.narrationStarted = true
        yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
      }
      block.text += decision.text
      yield { type: 'reasoning-delta', index: block.index, text: decision.text }
    }

    const uploaded = await uploadImages(options, signal)
    let promptParts: PromptParts = serializePromptParts({
      system: buildSystem(options),
      messages: options?.messages ?? [],
      tools: options?.tools ?? [],
      maxChars: config.prompt.maxChars,
      serialToolCalls: config.protocol.serialToolCalls !== false,
      keptImageKeys: uploaded.keptKeys,
    })
    let currentPrompt = promptParts.full
    const knownNames = new Set<string>()
    for (const tool of options?.tools ?? []) {
      const name = String((tool as any)?.name ?? '')
      if (name) knownNames.add(name)
    }
    if (looksLikeProbingQuestion(String(options?.messages?.at?.(-1)?.content ?? ''))) {
      deps.logger?.info?.('freetoken: user prompt looks like a probing question; protocol clause enforces no self-disclosure')
    }

    let finishReason: string | undefined
    let rounds = 0
    let echoedTranscript = false
    let rejectedRaw: string | null = null
    let rejectedReason: string | undefined
    let toolCallRetried = false
    const maxRounds = Math.max(0, config.protocol.maxContinuations)
    const usageRounds: { prompt: string; outputChars: number; total?: number }[] = []

    if (uploaded.notice) {
      for (const chunk of emitTextDelta(uploaded.notice)) yield chunk
    }

    let narrationFilter = new NarrationFilter(config.narration.enabled)

    try {
      for (;;) {
        let roundError: unknown
        const roundUsage: { prompt: string; outputChars: number; total?: number } = {
          prompt: currentPrompt,
          outputChars: 0,
        }
        usageRounds.push(roundUsage)
        finishReason = undefined
        const textLenAtRoundStart = state.text?.text.length ?? 0
        let filter = new ToolCallStreamFilter(knownNames)
        let reasoningSanitizer = new ReasoningSanitizer()
        let echoGuard = new TranscriptEchoGuard()
        let systemMarkerFilter = new SystemMarkerStreamFilter()
        let boilerplate = new BoilerplateFilter()
        narrationFilter = new NarrationFilter(config.narration.enabled)
        try {
          const request: BackendRequest = {
            provider: 'deepseek-web',
            model: String(options?.model ?? 'deepseek-chat'),
            prompt: currentPrompt,
            promptParts: {
              head: promptParts.head,
              entries: promptParts.entries,
              transcript: promptParts.transcript,
              maxChars: config.prompt.maxChars,
            },
            messages: options?.messages ?? [],
            ...(typeof options?.system === 'string' ? { system: buildSystem(options) } : {}),
            tools: options?.tools ?? [],
            thinkingEnabled,
            modelType: thinkingEnabled ? 'default' : 'default',
            ...(uploaded.ids.length > 0 ? { refFileIds: uploaded.ids } : {}),
            ...(uploaded.keys.length > 0 ? { refKeys: uploaded.keys } : {}),
            ...(signal ? { signal } : {}),
            ...(typeof options?.sessionId === 'string' && options.sessionId ? { sessionId: String(options.sessionId) } : {}),
            ...(options?.purpose ? { purpose: options.purpose } : {}),
            idleTimeoutMs: 120_000,
          }
          for await (const event of backend.stream(request)) {
            const kind = String(event?.kind ?? '')
            if (kind === 'thinking') {
              roundUsage.outputChars += String(event.text ?? '').length
              const clean = reasoningSanitizer.push(String(event.text ?? ''))
              for (const chunk of emitReasoningDelta(clean)) yield chunk
              continue
            }
            if (kind === 'text') {
              const rawText = String(event.text ?? '')
              roundUsage.outputChars += rawText.length
              const out = filter.push(rawText)
              const boiled = boilerplate.push(out.text)
              const guarded = echoGuard.push(boiled.text)
              if (guarded.echoed) echoedTranscript = true
              const cleaned = systemMarkerFilter.push(guarded.text)
              const split = narrationFilter.push(cleaned.text)
              for (const chunk of emitTextDelta(split.text)) yield chunk
              if (split.narration) {
                reportNarration(split.narration)
                for (const chunk of emitNarrationReasoning(split.narration)) yield chunk
              }
              if (out.calls.length > 0) {
                for (const chunk of emitCalls(state, out.calls)) yield chunk
              }
              continue
            }
            if (kind === 'status') {
              deps.logger?.debug?.(`freetoken: web status=${String(event.value ?? '')}`)
              continue
            }
            if (kind === 'error') {
              if (isContextTooLong(event.message)) {
                throw new FreetokenError('PERMANENT', `freetoken: web context too long: ${String(event.message ?? '')}`)
              }
              const message = String(event.message ?? '')
              const muteLike = /封禁|禁言|muted|mute/i.test(message) || typeof event.mutedUntilMs === 'number'
              if (event.code === 'RATE_LIMIT' || muteLike) {
                if (muteLike) {
                  throw new FreetokenError('MUTED', `freetoken: 网页端已封禁/禁言本账号: ${message}`, {
                    retryable: false,
                  })
                }
                throw new FreetokenError('RATE_LIMIT', `freetoken: web rate limit: ${message}`, {
                  retryable: true,
                })
              }
              if (event.code === 'AUTH') {
                // 保留 AUTH 语义：上层（real-backend）据此做一次页面续签 token 重试；
                // 不重试时也必须是可识别的 AUTH，而不是笼统 TRANSPORT。
                throw new FreetokenError('AUTH', `freetoken: web auth failed: ${String(event.message ?? '')}`, {
                  retryable: false,
                })
              }
              throw new FreetokenError('TRANSPORT', `freetoken: web error: ${String(event.message ?? '')}`, { retryable: true })
            }
            if (kind === 'finish') {
              finishReason = String(event.reason ?? '')
              if (typeof event.totalTokens === 'number' && Number.isFinite(event.totalTokens)) {
                roundUsage.total = event.totalTokens
              }
            }
          }
        } catch (error) {
          if (signal?.aborted) throw new FreetokenError('TRANSPORT', 'freetoken: request aborted', { cause: error })
          if (rounds > 0) {
            roundError = error
            deps.logger?.warn?.(`freetoken: auto-continue round ${rounds} failed, keeping partial output: ${(error as any)?.message ?? error}`)
          } else {
            throw error
          }
        }

        const reasoningTail = reasoningSanitizer.flush()
        for (const chunk of emitReasoningDelta(reasoningTail)) yield chunk

        const drained = drainTextPipeline(filter, boilerplate, echoGuard, false)
        if (drained.echoed) echoedTranscript = true
        const markerPending = systemMarkerFilter.push(drained.text)
        const markerEnd = systemMarkerFilter.flush()
        const tail = `${markerPending.text}${markerEnd.text}`
        const drainedSplit = narrationFilter.push(tail)
        for (const chunk of emitTextDelta(drainedSplit.text)) yield chunk
        if (drainedSplit.narration) {
          reportNarration(drainedSplit.narration)
          for (const chunk of emitNarrationReasoning(drainedSplit.narration)) yield chunk
        }
        if (drained.calls.length > 0) {
          for (const chunk of emitCalls(state, drained.calls)) yield chunk
        }
        if (drained.rejected) {
          rejectedRaw = drained.rejected.raw
          rejectedReason = drained.rejected.reason ?? 'unparsable'
          deps.logger?.warn?.(
            `freetoken: tool call parse failed [${rejectedReason}] (${drained.rejected.raw.length} chars dropped; snippet: ${drained.rejected.raw.slice(0, 500)})`,
          )
        }

        const partial = state.text?.text ?? ''
        const roundChars = partial.length - textLenAtRoundStart
        const cutByServer = finishReason === undefined
        const midSentence = looksMidSentence(partial)
        deps.logger?.info?.(
          `freetoken: round ${rounds + 1} done [chars=${roundChars} total=${partial.length} finish=${finishReason ?? 'none'} midSentence=${midSentence}]`,
        )

        const canContinue = allowsAutoContinue(options?.purpose)
        const eligible =
          canContinue &&
          roundError === undefined &&
          config.protocol.autoContinue !== false &&
          rounds < maxRounds &&
          state.toolCalls === 0 &&
          !signal?.aborted &&
          partial.length > 0 &&
          roundChars > 0 &&
          (midSentence || cutByServer)
        const unexecutedProgram =
          !eligible &&
          canContinue &&
          roundError === undefined &&
          config.protocol.autoContinue !== false &&
          rounds < maxRounds &&
          state.toolCalls === 0 &&
          !toolCallRetried &&
          !signal?.aborted &&
          partial.length > 0 &&
          looksLikeUnexecutedToolProgram(partial)
        if (!eligible && !unexecutedProgram) break
        rounds += 1
        if (unexecutedProgram) toolCallRetried = true
        deps.logger?.info?.(
          unexecutedProgram
            ? `freetoken: model wrote a tool program as text; asking for a tool call (round ${rounds}/${maxRounds})`
            : `freetoken: answer looks cut mid-sentence; auto-continuing (round ${rounds}/${maxRounds})`,
        )
        promptParts = serializePromptParts({
          system: buildSystem(options),
          messages: [
            ...(options?.messages ?? []),
            { role: 'assistant', content: [{ type: 'text', text: partial }] },
            {
              role: 'user',
              content: [{ type: 'text', text: unexecutedProgram ? TOOL_CALL_RETRY_INSTRUCTION : CONTINUE_INSTRUCTION }],
            },
          ],
          tools: options?.tools ?? [],
          maxChars: config.prompt.maxChars,
          serialToolCalls: config.protocol.serialToolCalls !== false,
        })
        currentPrompt = promptParts.full
      }

      const narrationTail = narrationFilter.flush()
      for (const chunk of emitTextDelta(narrationTail.text)) yield chunk
      if (narrationTail.narration) reportNarration(narrationTail.narration)
    } catch (error) {
      if (error instanceof FreetokenError) throw error
      if (signal?.aborted) throw new FreetokenError('TRANSPORT', 'freetoken: request aborted', { cause: error })
      throw new FreetokenError('TRANSPORT', `freetoken: stream failed: ${(error as any)?.message ?? error}`, {
        retryable: true,
        cause: error,
      })
    }

    if (echoedTranscript && state.toolCalls === 0 && state.text && state.text.text.length > 0) {
      const notice = `\n\n[freetoken] 本轮有一段「历史回放格式」的内容被过滤（未上屏），回答可能不完整。\n`
      state.text.text += notice
      yield { type: 'text-delta', index: state.text.index, text: notice }
    }

    if (state.reasoning) {
      yield { type: 'block-end', index: state.reasoning.index, block: { type: 'reasoning', text: state.reasoning.text } }
    }
    if (state.narration) {
      yield { type: 'block-end', index: state.narration.index, block: { type: 'reasoning', text: state.narration.text } }
    }
    if (state.text) {
      yield { type: 'block-end', index: state.text.index, block: { type: 'text', text: state.text.text } }
    }

    let inputTokens = 0
    let outputTokens = 0
    let serverTotal = usageRounds.length > 0
    for (const round of usageRounds) {
      const estimatedOutput = Math.ceil(round.outputChars / 3.2)
      if (round.total !== undefined) {
        const output = Math.min(round.total, estimatedOutput)
        outputTokens += output
        inputTokens += round.total - output
      } else {
        serverTotal = false
        outputTokens += estimatedOutput
        inputTokens += estimateTokens(round.prompt)
      }
    }
    yield {
      type: 'usage',
      usage: {
        inputTokens,
        outputTokens,
        serverTotal,
        ...(state.reasoning ? { reasoningTokens: Math.min(outputTokens, estimateTokens(state.reasoning.text)) } : {}),
      },
    }

    if (state.toolCalls > 0) {
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (rejectedRaw) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message:
              rejectedReason === 'echo'
                ? '网页端本次输出的是历史内容回放（不是真要执行调用），已丢弃。'
                : rejectedReason === 'unbalanced'
                  ? '网页端本次输出被截断，调用没收全，已丢弃。'
                  : '网页端本次的调用格式无法解析，已丢弃。',
            code: 'EMPTY_RESPONSE',
          },
        },
      }
      return
    }
    const hasVisibleText = (state.text?.text?.length ?? 0) > 0
    if (!hasVisibleText) {
      if (config.narration.enabled && !narrationReported) {
        deps.onNarration?.({ model: null, local: localNarration({ phase: 'done' }), suppressed: deduper.suppressedCount })
      }
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message:
              'DeepSeek 网页端返回了空响应（可能触发频控或长上下文截断）',
            code: 'EMPTY_RESPONSE',
          },
        },
      }
      return
    }
    if (!narrationReported && config.narration.enabled) {
      deps.onNarration?.({ model: null, local: localNarration({ phase: 'done' }), suppressed: deduper.suppressedCount })
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  return { stream }
}