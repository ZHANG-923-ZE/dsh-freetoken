/**
 * dsh-Freetoken 插件入口。
 *
 * 铁律：本文件必须保持“轻”。重模块（浏览器/webapi/PoW/SSE/协议解析/节奏控制器）
 * 一律经 `lazy/load.ts` 动态加载，且只在 enabled === true 的运行时路径里发生。
 *
 * 关闭态行为（验收 M1）：只做配置归一化；`statusCommand` 为 true 时注册只读
 * `/freetoken status` 命令（零网络/零进程/零文件/零定时器），其余一律不碰。
 */

import { normalizeConfig, type FreetokenConfig } from './config.js'
import { createRuntime, type FreetokenRuntime, type RuntimeDeps } from './lifecycle.js'
import { registerFreetokenCommands } from './commands.js'
import { disabledSnapshot, type StatusSnapshot } from './status.js'

/** cordis 插件名（entry id 与 bundle patch 中保持一致）。 */
export const name = 'freetoken'

/** 启用路径需要 llm 服务；关闭态下这一等待不产生任何副作用。 */
export const inject = ['llm']

function log(ctx: any, level: 'info' | 'warn', message: string): void {
  try {
    ctx?.logger?.[level]?.(message)
  } catch {
    // 日志失败不得影响插件生命周期
  }
}

function idleSnapshot(config: FreetokenConfig): StatusSnapshot {
  const snapshot = disabledSnapshot(config)
  snapshot.enabled = config.enabled
  return snapshot
}

export function apply(ctx: any, rawConfig: unknown, overrides?: RuntimeDeps): void {
  const config = normalizeConfig(rawConfig)

  if (!config.enabled) {
    if (config.statusCommand) {
      registerFreetokenCommands(ctx, () => idleSnapshot(config), () => config)
    }
    log(ctx, 'info', 'freetoken: disabled (no provider registered, no heavy module loaded)')
    return
  }

  let runtime: FreetokenRuntime | undefined
  const startRuntime = (): void => {
    runtime = createRuntime(ctx, config, overrides ?? {})
    runtime.start()
  }
  const disposeRuntime = (): void => {
    const current = runtime
    runtime = undefined
    if (current) void current.dispose()
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      startRuntime()
      return disposeRuntime
    }, 'freetoken.runtime')
  } else {
    startRuntime()
  }

  if (config.statusCommand) {
    registerFreetokenCommands(
      ctx,
      () => runtime?.status.snapshot() ?? idleSnapshot(config),
      () => config,
      () => runtime?.ops,
    )
  }
}
