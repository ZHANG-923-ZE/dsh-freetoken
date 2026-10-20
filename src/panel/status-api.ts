/**
 * 面板状态 API（Web 设置页的数据源；工作流 P5.2 / P5.5，验收 M15 / M17 / M27）。
 *
 * 设计约束：
 *  - 只读：仅把内存 StatusSnapshot 序列化成 JSON，不触发网络 / 文件 / 浏览器副作用；
 *  - 轻模块：只有 `import type`，不静态引用 transport / protocol / rhythm / session 等重模块
 *    （关闭态审计与懒加载边界因此不受影响）；
 *  - 无凭证：快照本身不含 token/cookie，本模块也不得新增任何凭证字段；
 *  - 诚实关闭态：enabled=false 时照样返回真实快照，客户端据此显示「已关闭（未启用）」并停表。
 *
 * 路由（相对宿主注册的前缀 /freetoken/api）：
 *  - GET /status    -> 200 + StatusSnapshot
 *  - GET /narration -> 200 + { model, local, suppressed }
 *  - 其它路由        -> 404 + { ok:false }
 *  - 非 GET          -> 405 + { ok:false }
 *  - 处理异常        -> 500 + { ok:false }
 */

import type { StatusSnapshot } from '../status.js'

/** 宿主注册前缀；同时兼容「宿主透传完整路径」的写法。 */
const API_PREFIX = '/freetoken/api'

export interface StatusApiRequest {
  method?: string
  url?: string
}

export interface StatusApiResponse {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}

/** 纯数据响应：路由层只产出它，写回层负责一次写出。 */
export class JsonResponse {
  constructor(
    public statusCode: number,
    public body: unknown,
  ) {}
}

/**
 * 归一化路由路径：
 *  - 容忍查询串（/status?x=1）与末尾斜杠（/status/）；
 *  - 容忍宿主透传完整前缀（/freetoken/api/status）或只剥掉 /freetoken（/api/status）。
 */
function routePath(rawUrl: string): string {
  const url = new URL(String(rawUrl || '/'), 'http://127.0.0.1')
  let pathname = url.pathname || '/'
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '')
  if (pathname === API_PREFIX) return '/'
  if (pathname.startsWith(API_PREFIX + '/')) return pathname.slice(API_PREFIX.length)
  if (pathname === '/api') return '/'
  if (pathname.startsWith('/api/')) return pathname.slice('/api'.length)
  return pathname
}

function readSnapshot(getSnapshot: () => StatusSnapshot): StatusSnapshot {
  const snapshot = getSnapshot()
  if (!snapshot || typeof snapshot !== 'object') throw new Error('status snapshot unavailable')
  return snapshot
}

function buildResponse(req: StatusApiRequest, getSnapshot: () => StatusSnapshot): JsonResponse {
  // 只允许只读 GET；其余方法明确 405，绝不落成副作用路由。
  if (String(req.method ?? '').toUpperCase() !== 'GET') {
    return new JsonResponse(405, { ok: false, error: 'method-not-allowed' })
  }

  const route = routePath(String(req.url ?? '/'))

  if (route === '/status') {
    return new JsonResponse(200, readSnapshot(getSnapshot))
  }

  if (route === '/narration') {
    const snapshot = readSnapshot(getSnapshot)
    const narration = snapshot.narration
    return new JsonResponse(200, {
      model: narration?.model ?? null,
      local: narration?.local ?? null,
      suppressed: narration?.dedupeSuppressed ?? 0,
    })
  }

  return new JsonResponse(404, { ok: false, error: 'not-found' })
}

function writeJson(res: StatusApiResponse, response: JsonResponse): void {
  res.statusCode = response.statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(response.body))
}

/**
 * 创建宿主 webServer 的 prefix handler。
 * 任何异常（含 getSnapshot 抛错、响应对象异常）都收敛成 500 JSON，绝不冒泡进宿主。
 */
export function createStatusApiHandler(
  getSnapshot: () => StatusSnapshot,
): (req: StatusApiRequest, res: StatusApiResponse) => void {
  return (req, res) => {
    try {
      writeJson(res, buildResponse(req, getSnapshot))
    } catch {
      try {
        writeJson(res, new JsonResponse(500, { ok: false, error: 'internal-error' }))
      } catch {
        // 响应对象本身不可写（连接已断开等）：静默失败，不影响宿主其它路由。
      }
    }
  }
}