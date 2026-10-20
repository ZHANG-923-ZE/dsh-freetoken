/**
 * 执行后端接口（可插拔）。
 *
 * v1 只实现 `cdp`（真实 Edge + CDP）；`dom` 是长期可插拔选项，仅保留接口与配置，
 * 运行时明确报错（不静默降级）。PoW 必须在页内完成（R14），后端接口因此把
 * “启动/流式请求/关闭”放在一起，缺席时直接失败。
 *
 * v1.2（2026-10-20）：接口下沉为**原始网页事件**，协议序列化/工具解析/narration
 * 统一由 `protocol/pipeline`（懒加载）处理；后端只负责传输与页面能力。
 */

import type { FreetokenConfig } from '../config.js'
import { FreetokenError } from '../adapter/errors.js'
import type { StoredAuth } from './auth.js'
import type { ProbeResult } from './probe.js'

export interface BackendRequest {
  provider: string
  model: string
  /** 已渲染的完整 prompt（含系统段、工具目录、历史）。 */
  prompt: string
  /**
   * 结构化 prompt 拆分（链式投喂用）：head = 系统+协议+工具目录；entries = 未截断历史。
   * 缺省时 vendor 走全量重发。
   */
  promptParts?: { head: string; entries: readonly string[]; transcript?: string; maxChars?: number }
  messages: readonly unknown[]
  system?: string
  tools?: readonly unknown[]
  toolHistory?: unknown
  thinkingEnabled: boolean
  modelType: 'default' | 'expert' | 'vision'
  refFileIds?: readonly string[]
  refKeys?: readonly string[]
  temperature?: number
  maxTokens?: number
  stop?: readonly string[]
  signal?: AbortSignal
  sessionId?: string
  purpose?: 'compaction' | 'session-title'
  /** 允许自动续写的语义（chat 类请求 true）。 */
  autoContinue?: boolean
  /** 本轮只允许这些工具名参与解析（0 个工具 = 不启用工具协议）。 */
  knownToolNames?: readonly string[]
  /** 建连期限（vendor 默认 45s）。 */
  connectTimeoutMs?: number
  /** 空闲中断（vendor 默认 120s）。 */
  idleTimeoutMs?: number
}

export interface UploadImageInput {
  /** base64（不含 data: 前缀）或原始字节。 */
  data: string | Uint8Array
  name: string
  mediaType?: string
}

export interface ExecutionBackend {
  readonly kind: 'cdp' | 'dom'
  /** 懒启动：第一次真实请求前调用（浏览器启动/登录态注入都在这里）。 */
  start(signal?: AbortSignal): Promise<void>
  /** 单路原始网页事件流；同一时刻只允许一个消费者（由 RhythmController 保证）。 */
  stream(request: BackendRequest): AsyncIterable<any>
  /** 图片上传（图片理解 E2E）；未实现时抛 BACKEND_NOT_READY。 */
  uploadImage?(input: UploadImageInput): Promise<{ fileId: string }>
  /** 只读登录探活（零额度）；只在显式命令里调用。 */
  probe?(auth: StoredAuth): Promise<ProbeResult>
  /**
   * 凭证被替换（重新登录/换 token）后调用：丢弃传输层页面上**旧凭证**的登录态。
   *
   * 为什么必须显式作废：传输层页面是常驻的，页面 localStorage 里可能还是旧 token；
   * 不清理的话，下一次请求可能把旧 token 当“页面上的新凭证”采纳，或把新 token 装到
   * 一个还带着旧站点会话的页面上 —— 两种都会让新登录看起来“立刻又失效”。
   * 实现方只应做本地动作（清签名/重启传输层），不发网络请求。
   */
  resetCredentialSession?(): Promise<void> | void
  /** 关闭浏览器进程树/释放句柄；幂等。 */
  close(): Promise<void>
}

/** P1 占位后端：provider 已可见，但真实调用返回明确错误（下一轮接入 CDP）。 */
export function createUnavailableBackend(config: FreetokenConfig): ExecutionBackend {
  const kind = config.backend
  const message =
    kind === 'dom'
      ? 'freetoken: DOM backend is a planned option and is not implemented in v1'
      : 'freetoken: browser backend is not wired yet (P1 work in progress)'
  const fail = (): never => {
    throw new FreetokenError('BACKEND_NOT_READY', message)
  }
  return {
    kind,
    async start() {
      fail()
    },
    async *stream() {
      fail()
    },
    async close() {
      // 无资源可释放
    },
  }
}
