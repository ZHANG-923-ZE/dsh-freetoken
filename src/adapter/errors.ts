/**
 * 插件错误类型：带稳定 code，供 Harness 侧按 code 路由/重试。
 * 消息不得包含凭证。
 */

export type FreetokenErrorCode =
  | 'MISSING_CREDENTIAL'
  | 'INVALID_CREDENTIAL'
  | 'BACKEND_NOT_READY'
  | 'POW_REQUIRES_BROWSER'
  | 'TRANSPORT_IN_USE'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'EMPTY_RESPONSE'
  | 'TRANSPORT'
  | 'PERMANENT'
  | 'MUTED'
  | 'DAILY_BUDGET'
  | 'QUEUE_FULL'

export class FreetokenError extends Error {
  readonly code: FreetokenErrorCode
  readonly retryable: boolean

  constructor(code: FreetokenErrorCode, message: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'FreetokenError'
    this.code = code
    this.retryable = options?.retryable ?? false
  }
}
