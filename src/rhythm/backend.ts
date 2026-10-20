/**
 * 节奏门卫后端：把 ExecutionBackend 包一层 RhythmController，使其成为所有网页请求的
 * **唯一出口**（红线 2 / M11 / M14 / M22）。
 *
 * - `stream()` 每次真实调用都先 acquire（日预算/队列/静默/串行锁/抖动/爆发计数），
 *   再交给内层后端；结束后 release（必要时安排静默）。
 * - 失败按事件分类：可重试码 + 未产出任何 chunk 时才按随机退避重试；
 *   AUTH/mute/QUOTA 一律不重试（R12）。
 * - L3 单飞（M16）：**内部请求**（compaction/session-title）同 key 并发只发一次，
 *   后到者复用首个请求的事件缓冲；聊天请求不缓冲（保持真流式）。
 * - 本模块是重模块（依赖 rhythm/controller），只允许经 lazy/load.ts 加载。
 */

import { createHash } from 'node:crypto'
import type { FreetokenConfig } from '../config.js'
import type { BackendRequest, ExecutionBackend, UploadImageInput } from '../transport/backend.js'
import type { StoredAuth } from '../transport/auth.js'
import type { ProbeResult } from '../transport/probe.js'
import type { StatusSnapshot } from '../status.js'
import { createRhythmController, type RhythmController, type RequestKind } from './controller.js'
import { isRetryableCode } from './retry.js'
import { FreetokenError } from '../adapter/errors.js'
import { haltBlocksSend, readHalt } from '../transport/halt.js'

export interface RhythmBackendDeps {
  onStatus?: (patch: Partial<StatusSnapshot>) => void
  onMetric?: (name: string, value?: number) => void
  logger?: { info?: (message: string) => void; warn?: (message: string) => void; debug?: (message: string) => void }
  /** 测试注入：退避 sleep。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** 启动时从磁盘恢复的今日请求数（跨重启累计）。 */
  initialTodayRequests?: number
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!(ms > 0)) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    ;(timer as any).unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function kindFor(purpose: string | undefined): RequestKind {
  if (purpose === 'compaction') return 'compaction'
  if (purpose === 'session-title') return 'session-title'
  return 'chat'
}

function errorCode(error: any): string {
  const raw = String(error?.code ?? error?.name ?? 'TRANSPORT')
  const message = String(error?.message ?? '')
  // 🔴 vendor 把账号级 mute 归在 `RATE_LIMIT` + 中文封禁文案里；而 RhythmController 只有收到
  // 含 `MUT` 的码才会置 halted/mutedUntil 并落盘熔断。旧实现把 mute 改写成 `AUTH` ⇒ 真实链路
  // 永远不熔断（M26 的止损结论在真实链路不可达）。这里必须映射成 `MUTED`。
  if (/\bmuted?\b|user\s+is\s+muted/i.test(message) || /封禁|禁言|账号已被限制/.test(message)) {
    return 'MUTED'
  }
  return raw
}

interface Inflight {
  events: any[]
  done: Promise<void>
  resolve: () => void
  error?: unknown
}

export function createRhythmBackend(
  inner: ExecutionBackend,
  config: FreetokenConfig,
  deps: RhythmBackendDeps = {},
): ExecutionBackend {
  let controller: RhythmController | undefined
  const sleep = deps.sleep ?? abortableSleep
  const inflight = new Map<string, Inflight>()

  const ensureController = (): RhythmController => {
    controller ??= createRhythmController({
      config,
      onStatus: deps.onStatus,
      onMetric: deps.onMetric,
      ...(deps.initialTodayRequests !== undefined ? { initialTodayRequests: deps.initialTodayRequests } : {}),
    })
    return controller
  }

  const coalesceKey = (request: BackendRequest): string =>
    createHash('sha1')
      .update(
        [
          request.provider,
          request.model,
          request.purpose ?? 'chat',
          request.sessionId ?? '',
          request.prompt,
          JSON.stringify(request.refFileIds ?? []),
        ].join('|'),
      )
      .digest('hex')

  const coalescable = (request: BackendRequest): boolean =>
    config.coalesce.enabled && (request.purpose === 'compaction' || request.purpose === 'session-title')

  async function* runWithLease(request: BackendRequest): AsyncGenerator<any> {
    const rhythm = ensureController()
    const purpose = request.purpose
    const sessionId = request.sessionId
    const signal = request.signal
    const maxRetries = config.retry.maxRetries
    let attempt = 0

    for (;;) {
      const lease = await rhythm.acquire({
        kind: kindFor(purpose),
        ...(purpose ? { purpose } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(signal ? { signal } : {}),
      })
      let emitted = false
      let sent = false
      try {
        lease.markSent()
        sent = true
        for await (const event of inner.stream(request)) {
          emitted = true
          yield event
        }
        lease.markSuccess()
        return
      } catch (error: any) {
        const code = errorCode(error)
        const retryable = Boolean(error?.retryable) && isRetryableCode(code)
        const providerDelay = Number(error?.providerRetryAfterMs)
        let delay = 0
        try {
          delay = lease.markFailure(code, String(error?.message ?? error), retryable)
        } catch {
          delay = 0
        }
        if (Number.isFinite(providerDelay) && providerDelay > delay) delay = providerDelay
        const canRetry = sent && !emitted && retryable && attempt < maxRetries && !signal?.aborted
        if (!canRetry || !(delay > 0)) throw error
        attempt += 1
        deps.logger?.warn?.(`freetoken: retrying after ${delay}ms (attempt ${attempt}/${maxRetries}, code=${code})`)
        await sleep(delay, signal)
        continue
      } finally {
        lease.release()
      }
    }
  }

  return {
    kind: inner.kind,

    async start(signal?: AbortSignal) {
      ensureController()
      await inner.start(signal)
    },

    async *stream(request: BackendRequest) {
      // 落盘熔断优先：mute/封禁跨重启保持停发，任何请求都不再出网。
      const halt = readHalt()
      if (haltBlocksSend(halt)) {
        throw new FreetokenError(
          'PERMANENT',
          `freetoken: sending is halted (${halt?.reason ?? 'muted'}) until ${
            halt?.mutedUntil ? new Date(halt.mutedUntil).toISOString() : 'manual /freetoken logout'
          }; no request was sent`,
        )
      }
      if (!coalescable(request)) {
        yield* runWithLease(request)
        return
      }
      const key = coalesceKey(request)
      const existing = inflight.get(key)
      if (existing) {
        deps.onMetric?.('coalesced', 1)
        await existing.done
        if (existing.error) throw existing.error
        for (const event of existing.events) yield event
        return
      }

      let resolveDone!: () => void
      const record: Inflight = {
        events: [],
        done: new Promise<void>((resolve) => {
          resolveDone = resolve
        }),
        resolve: () => resolveDone(),
      }
      inflight.set(key, record)
      try {
        for await (const event of runWithLease(request)) {
          record.events.push(event)
          yield event
        }
      } catch (error) {
        record.error = error
        throw error
      } finally {
        inflight.delete(key)
        record.resolve()
      }
    },

    async uploadImage(input: UploadImageInput) {
      if (!inner.uploadImage) throw new Error('freetoken: upload is not supported by this backend')
      // 上传也是一次网页请求（PoW + 页面 fetch）：同样经过节奏门卫。
      const lease = await ensureController().acquire({ kind: 'chat' })
      try {
        lease.markSent()
        const result = await inner.uploadImage(input)
        lease.markSuccess()
        return result
      } catch (error: any) {
        lease.markFailure(errorCode(error), String(error?.message ?? error), false)
        throw error
      } finally {
        lease.release()
      }
    },

    async probe(auth: StoredAuth): Promise<ProbeResult> {
      if (!inner.probe) throw new Error('freetoken: probe is not supported by this backend')
      const lease = await ensureController().acquire({ kind: 'internal' })
      try {
        lease.markSent()
        const result = await inner.probe(auth)
        lease.markSuccess()
        return result
      } catch (error: any) {
        lease.markFailure(errorCode(error), String(error?.message ?? error), false)
        throw error
      } finally {
        lease.release()
      }
    },

    resetCredentialSession() {
      // 换凭证只清本地页面登录态，不属于网页请求 ⇒ 不进节奏门卫。
      return inner.resetCredentialSession?.()
    },

    async close() {
      try {
        controller?.dispose()
      } finally {
        controller = undefined
        await inner.close()
      }
    },
  }
}