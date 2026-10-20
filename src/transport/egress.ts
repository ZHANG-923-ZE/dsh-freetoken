/**
 * egress：所有发往 chat.deepseek.com 的传输层出口（唯一 fetch 持有者，红线 R2）。
 *
 * - 真实请求一律使用**页面内 fetch**（CDP `Runtime.evaluate`），不在宿主 Node 侧发；
 * - `webapi` 通过 `setFetchImpl()` 接收本模块安装的出口；除此之外没有别的注入点；
 * - 浏览器不可用时不降级（R14），由调用方给出 `POW_REQUIRES_BROWSER`。
 *
 * 本模块是重模块，只允许经 `lazy/load.ts` 加载。
 */

import {
  createBrowserFetch,
  shutdownBrowserTransport,
  systemBrowserAvailable,
} from './vendor/browser-transport.js'
import { currentFetch, setFetchImpl } from './vendor/webapi.js'
import { probeAuth, type ProbeResult } from './probe.js'
import type { StoredAuth } from './auth.js'

let installed = false

/** 系统里是否存在可用的 Chromium 系浏览器（不含“是否已启动”）。 */
export function browserAvailable(): boolean {
  return systemBrowserAvailable()
}

/** 安装页面内 fetch 作为唯一出口；幂等。 */
export function installBrowserEgress(): void {
  if (installed) return
  setFetchImpl(createBrowserFetch())
  installed = true
}

/** 卸载出口（不关闭浏览器）。 */
export function uninstallEgress(): void {
  if (!installed) return
  installed = false
  try {
    setFetchImpl(undefined)
  } catch {
    // webapi 可能已被卸载：忽略即可
  }
}

/** 关闭浏览器进程树并卸载出口；幂等。 */
export async function closeEgress(): Promise<void> {
  uninstallEgress()
  try {
    await shutdownBrowserTransport()
  } catch {
    // 关闭失败留给下次启动清理
  }
}

/** 当前出口是否已安装（status/诊断用）。 */
export function egressInstalled(): boolean {
  return installed
}

/** vendor 清理器/其它模块必须使用的页面出口（与 install 的是同一个实现）。 */
export function pageFetch(): typeof fetch {
  return currentFetch as unknown as typeof fetch
}

/**
 * 只读探活（`GET /api/v0/users/current`，零额度）。
 * 必须显式调用；走页面内 fetch，不额外开 Node 网络栈。
 */
export async function probeViaEgress(auth: StoredAuth): Promise<ProbeResult> {
  installBrowserEgress()
  return probeAuth(auth, pageFetch())
}