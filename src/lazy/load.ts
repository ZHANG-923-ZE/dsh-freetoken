/**
 * 唯一懒加载入口。
 *
 * 规则（工作流 §3.4）：
 *  - `src/lazy/` 之外的源码禁止动态 `import()`；
 *  - 浏览器、webapi、PoW、SSE、协议解析、节奏控制器等重模块只能从这里加载；
 *  - 每次加载记账，写入 status.lazyLoaded，供关闭态审计与面板展示。
 *
 * P0 只提供机制与记账（MANIFEST 为空）；P1 起逐项登记。
 */

/** 已加载的懒模块 key（去重、保序）。 */
const loadedKeys: string[] = []

type ModuleLoader = () => Promise<unknown>

/** 懒加载清单：key → 真实动态 import。仅本文件允许出现 `import(...)`。 */
const MANIFEST: Readonly<Record<string, ModuleLoader>> = {
  'transport/real-backend': () => import('../transport/real-backend.js'),
  'transport/browser-login': () => import('../transport/vendor/browser-login.js'),
  'protocol/pipeline': () => import('../protocol/pipeline.js'),
  'rhythm/backend': () => import('../rhythm/backend.js'),
}

export function loadedKeysSnapshot(): string[] {
  return [...loadedKeys]
}

let observer: ((keys: readonly string[]) => void) | undefined

/** 订阅“懒加载发生”事件（status 回填用）；返回取消订阅函数。 */
export function onLazyLoaded(callback: (keys: readonly string[]) => void): () => void {
  observer = callback
  return () => {
    if (observer === callback) observer = undefined
  }
}

export function resetLazyForTest(): void {
  loadedKeys.length = 0
}

/** 加载一个登记过的重模块；未登记直接失败（fail-closed，避免误加载）。 */
export async function ensureLazy<T = unknown>(key: string): Promise<T> {
  const loader = MANIFEST[key]
  if (loader === undefined) {
    throw new Error(`freetoken: unknown lazy module "${key}" (not registered in lazy/load.ts)`)
  }
  if (!loadedKeys.includes(key)) {
    loadedKeys.push(key)
    try {
      observer?.(loadedKeysSnapshot())
    } catch {
      // 观测失败不影响加载
    }
  }
  return (await loader()) as T
}
