/**
 * FreetokenAdapter：把 Harness 的 GenerateOptions 接到执行后端。
 *
 * 职责边界：
 *  - provider 元数据 / 模型目录 / 精确模型解析（轻模块）；
 *  - `session-title` 本地合成（L1：零网页请求）；
 *  - 凭证门槛（未登录直接 `MISSING_CREDENTIAL`）；
 *  - 非标题请求：懒加载 `protocol/pipeline`，由它完成协议序列化/工具解析/narration。
 */

import type { FreetokenConfig } from '../config.js'
import { FreetokenLlmAdapterBase, type ProviderInfo, type ResolvedModelInfo } from './base.js'
import { FreetokenError } from './errors.js'
import { MODEL_SPECS, PROVIDER, PROVIDER_NAME, modelInfoFor, resolveSpec } from './models.js'
import { localTitleStream } from './local-title.js'
import type { ExecutionBackend } from '../transport/backend.js'
import type { StoredAuth } from '../transport/auth.js'
import { ensureLazy } from '../lazy/load.js'

export interface AdapterDeps {
  config: FreetokenConfig
  getAuth(): StoredAuth | undefined
  backend: ExecutionBackend
  /** 附件服务（图片理解用；关闭态不接触）。 */
  ctx?: any
  logger?: { info?: (message: string) => void; warn?: (message: string) => void; debug?: (message: string) => void }
  /** 旁白/本地讲解（进 status/面板，不进正文）。 */
  onNarration?(input: { model?: string | null; local?: string | null; suppressed?: number }): void
  onMetric?(name: string, value?: number): void
  /** 可观测钩子；不得抛错影响流。 */
  onChunk?(chunk: any): void
}

interface PipelineModule {
  createPipeline(deps: any): { stream(options: any): AsyncGenerator<any> }
}

export class FreetokenAdapter extends FreetokenLlmAdapterBase {
  private pipeline: { stream(options: any): AsyncGenerator<any> } | undefined

  constructor(private readonly deps: AdapterDeps) {
    super()
  }

  override providerInfo(provider: string): ProviderInfo {
    return { id: provider, name: PROVIDER_NAME }
  }

  override providerRetryPolicy(_provider: string): unknown {
    const retry = this.deps.config.retry
    // 完整**扁平**策略（host 的 llm-retry 读的是扁平字段；缺 `retryableCodes`
    // 会在失败路径上抛 `Cannot read properties of undefined (reading 'includes')`，
    // 把真正的错误信息整个盖掉 —— 2026-10-20 真机踩过）。
    return {
      mode: 'normal',
      maxRetries: retry.maxRetries,
      retryableCodes: ['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'RATE_LIMIT'],
      initialDelayMs: retry.baseDelayMs,
      maxDelayMs: retry.maxDelayMs,
      jitterRatio: retry.jitterRatio,
    }
  }

  override async listModels(provider: string): Promise<readonly ResolvedModelInfo[]> {
    return MODEL_SPECS.map((spec) => modelInfoFor(provider, spec))
  }

  override async resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    return modelInfoFor(provider, resolveSpec(model))
  }

  private async ensurePipeline(): Promise<{ stream(options: any): AsyncGenerator<any> }> {
    if (this.pipeline) return this.pipeline
    const module = await ensureLazy<PipelineModule>('protocol/pipeline')
    const attachments = (() => {
      try {
        return this.deps.ctx?.get?.('attachments') ?? this.deps.ctx?.attachments
      } catch {
        return undefined
      }
    })()
    this.pipeline = module.createPipeline({
      config: this.deps.config,
      backend: this.deps.backend,
      logger: this.deps.logger,
      onNarration: this.deps.onNarration,
      onMetric: this.deps.onMetric,
      readImage: async (ref: any, signal?: AbortSignal) => {
        if (!attachments || typeof attachments.readImage !== 'function') {
          throw new Error('attachment service unavailable (ctx.attachments)')
        }
        const stored = await attachments.readImage(ref, signal)
        return {
          data: stored?.data,
          ...(stored?.ref?.mediaType ? { mediaType: String(stored.ref.mediaType) } : {}),
          ...(stored?.ref?.name ? { name: String(stored.ref.name) } : {}),
        }
      },
    })
    return this.pipeline
  }

  override async *stream(options: any): AsyncGenerator<any> {
    const config = this.deps.config

    // L1：标题本地合成，零网页请求（无论是否登录都不发请求）。
    if (options?.purpose === 'session-title' && config.localTitle.enabled) {
      try {
        this.deps.onMetric?.('titleSaved', 1)
      } catch {
        // 观测失败不影响标题
      }
      yield* localTitleStream(options?.messages, config.localTitle.maxChars)
      return
    }

    const auth = this.deps.getAuth()
    if (!auth?.auth?.token) {
      throw new FreetokenError(
        'MISSING_CREDENTIAL',
        'freetoken: not logged in to chat.deepseek.com; run `/freetoken login` first',
      )
    }

    const spec = resolveSpec(String(options?.model ?? ''))
    await this.deps.backend.start(options?.signal)

    const request = {
      ...options,
      provider: PROVIDER,
      model: spec.id,
    }

    const pipeline = await this.ensurePipeline()
    for await (const chunk of pipeline.stream(request)) {
      try {
        this.deps.onChunk?.(chunk)
      } catch {
        // 观测失败不得影响模型流
      }
      yield chunk
    }
  }
}

export function createAdapter(deps: AdapterDeps): FreetokenAdapter {
  return new FreetokenAdapter(deps)
}