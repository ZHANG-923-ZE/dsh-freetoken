/**
 * 懒执行后端：轻量门面，第一次真实请求时才加载真实后端（浏览器/webapi/PoW/SSE）。
 * 关闭态与 enabled-idle 都不会触碰重模块。
 *
 * 组合顺序（P4）：real-backend → rhythm/backend（唯一出口门卫）。
 */

import type { FreetokenConfig } from '../config.js'
import type { StatusSnapshot } from '../status.js'
import type { BackendRequest, ExecutionBackend, UploadImageInput } from './backend.js'
import type { StoredAuth } from './auth.js'
import type { ProbeResult } from './probe.js'
import { ensureLazy } from '../lazy/load.js'

interface RealBackendModule {
  createRealBackend(
    config: FreetokenConfig,
    deps?: {
      logger?: any
      onAuthRefreshed?: (auth: StoredAuth) => void
      onAuthFailed?: (message: string) => void
      onStatus?: (patch: Partial<StatusSnapshot>) => void
    },
  ): ExecutionBackend
}

interface RhythmBackendModule {
  createRhythmBackend(
    inner: ExecutionBackend,
    config: FreetokenConfig,
    deps?: {
      onStatus?: (patch: Partial<StatusSnapshot>) => void
      onMetric?: (name: string, value?: number) => void
      logger?: any
      initialTodayRequests?: number
    },
  ): ExecutionBackend
}

export interface LazyBackendDeps {
  logger?: { info?: (message: string) => void; warn?: (message: string) => void; debug?: (message: string) => void }
  onStatus?: (patch: Partial<StatusSnapshot>) => void
  onMetric?: (name: string, value?: number) => void
  onAuthRefreshed?: (auth: StoredAuth) => void
  /** 自动续签失败：明确告知“需要重新登录”（不能静默把登录态当正常）。 */
  onAuthFailed?: (message: string) => void
  initialTodayRequests?: number
}

export function createLazyBackend(config: FreetokenConfig, deps: LazyBackendDeps = {}): ExecutionBackend {
  let real: ExecutionBackend | undefined
  /**
   * 正在加载中的 promise（P0 修复）。
   *
   * 🔴 为什么必须记"加载中"而不只是"已完成"：
   * `autoStartWarmSession` 的预热会调 `backend.start()`，**同时**第一个真实请求会调
   * `backend.stream()` —— 两者都走 `load()`。旧写法只在 `real` 已就绪时复用，
   * 于是并发时会**创建两个 real-backend**，而 real-backend 的 `start()` 会去拿
   * **单实例锁** ⇒ 第二个实例报 `another transport instance is running (pid=<自己的 pid>)`
   * ⇒ 首次请求直接失败（首请求必现的时序，不是罕见竞态）。
   */
  let loading: Promise<ExecutionBackend> | undefined

  const load = async (): Promise<ExecutionBackend> => {
    if (real) return real
    loading ??= (async () => {
      const realModule = await ensureLazy<RealBackendModule>('transport/real-backend')
      const inner = realModule.createRealBackend(config, {
        logger: deps.logger,
        ...(deps.onAuthRefreshed ? { onAuthRefreshed: deps.onAuthRefreshed } : {}),
        ...(deps.onAuthFailed ? { onAuthFailed: deps.onAuthFailed } : {}),
        // 常驻守护的状态要能回到面板（否则 /freetoken status 永远显示 idle）。
        ...(deps.onStatus ? { onStatus: deps.onStatus } : {}),
      })
      const rhythmModule = await ensureLazy<RhythmBackendModule>('rhythm/backend')
      return rhythmModule.createRhythmBackend(inner, config, {
        onStatus: deps.onStatus,
        onMetric: deps.onMetric,
        logger: deps.logger,
        ...(deps.initialTodayRequests !== undefined ? { initialTodayRequests: deps.initialTodayRequests } : {}),
      })
    })()
    try {
      real = await loading
      return real
    } finally {
      // 失败也要清掉 loading：否则一次失败会被永久缓存，后续请求永远拿不到后端。
      loading = undefined
    }
  }

  return {
    kind: config.backend,
    async start(signal?: AbortSignal) {
      const backend = await load()
      await backend.start(signal)
    },
    async *stream(request: BackendRequest) {
      const backend = await load()
      yield* backend.stream(request)
    },
    async uploadImage(input: UploadImageInput) {
      const backend = await load()
      if (!backend.uploadImage) throw new Error('freetoken: upload is not supported by this backend')
      return await backend.uploadImage(input)
    },
    async probe(auth: StoredAuth): Promise<ProbeResult> {
      const backend = await load()
      if (!backend.probe) throw new Error('freetoken: probe is not supported by this backend')
      return await backend.probe(auth)
    },
    resetCredentialSession() {
      // 真实后端还没加载时无需清理（页面上还没有属于旧凭证的登录态）。
      return real?.resetCredentialSession?.()
    },
    async close() {
      if (real) await real.close()
      real = undefined
    },
  }
}