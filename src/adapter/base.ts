/**
 * 自带 LlmAdapter 契约基类。
 *
 * 为什么不是 `import { LlmAdapter } from '@deepseek-ai/dsh-llm'`：
 * 插件安装在 profile 的 node_modules 下，宿主不会把内核包暴露给插件解析图
 * （实测 `ERR_MODULE_NOT_FOUND`）。`registerAdapter` 按结构校验（调用方法），
 * 因此这里复制抽象类的契约形状，语义上“继承”，不形成版本绑定。
 */

export interface ProviderInfo {
  id: string
  name: string
}

export interface ResolvedModelInfo {
  provider: string
  id: string
  name: string
  description?: string
  inputModalities?: readonly string[]
  context?: { contextWindow: number }
  defaultMaxTokens?: number
  /** Harness 契约：system 变更以历史中的 system 消息下发（不重写会话首条）。 */
  systemPromptUpdate?: 'in-history'
  /** Harness 契约：工具集变更以 developer 消息随历史下发。 */
  toolUpdate?: 'in-history'
  reasoning?: {
    efforts: readonly { id: string; name: string; description?: string }[]
    defaultEffort?: string
  }
}

export interface PreparedAdapterCall {
  model: ResolvedModelInfo
  stream(options: any): AsyncIterable<any>
}

export class FreetokenLlmAdapterBase {
  providerInfo(provider: string): ProviderInfo {
    return { id: provider, name: provider }
  }

  providerRetryPolicy(_provider: string): unknown {
    return undefined
  }

  /**
   * 图片请求计价：本路由不声明 → undefined（消费者回落到中性估算）。
   * ⚠️ 必须存在：host 计量/压缩路径会无条件转调它，缺失会抛 not a function。
   */
  imageRequestPricing(_provider: string, _model: string): unknown {
    return undefined
  }

  listModels(_provider: string): Promise<readonly ResolvedModelInfo[]> {
    return Promise.resolve([])
  }

  resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model),
      stream: (options: any) => this.stream(options),
    }
  }

  stream(_options: any): AsyncIterable<any> {
    throw new Error('freetoken: adapter.stream() must be implemented')
  }
}
