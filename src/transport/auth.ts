/**
 * 单账号凭证存储。
 *
 * 红线：凭证只落本机 `~/.dsh/freetoken/auth.json`；不写日志、不进 prompt。
 * 原子写（临时文件 + rename）避免半截文件；读取失败按“未登录”处理。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { freetokenPath } from './paths.js'

export interface StoredCredential {
  token: string
  cookie?: string
  hifDliq?: string
  hifLeim?: string
  clientVersion?: string
  userAgent?: string
  /** 登录时从真实浏览器抓到的请求头快照（顺序与值都按浏览器原样，用于指纹一致，R13）。 */
  extraHeaders?: Record<string, string>
  /** 页面内 PoW 求解用的 WASM 地址（登录页捕获；缺省由 vendor 兜底）。 */
  wasmUrl?: string
}

export interface StoredAuth {
  version: 1
  account: {
    id: string
    displayName?: string
  }
  auth: StoredCredential
  /**
   * 稳定的账号身份（服务端 `user.id`；登录探活成功后回填）。
   *
   * 为什么必须存：vendor 的会话槽/投喂链用 `accountKey(auth)` 做归属键，而它有
   * `user.id` 时用 id、没有时退回 `token|cookie`。网页端 token/cookie 每次刷新都会变
   * ⇒ 没有 id 时，**刷新一次凭证就被当成“换了账号”**：旧网页会话被退役、投喂链断开、
   * 下一轮全量重发（用户看到的就是“聊着聊着上下文没了 / 网页端又新建一个窗口”）。
   * vendor 早在 0.6.18 就修过这条，但本插件没把 id 传下去，等于修复未生效。
   */
  userId?: string
  savedAt: number
}

export function authPath(env: NodeJS.ProcessEnv = process.env): string {
  return freetokenPath('auth.json', env)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeHeaders(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.length > 0) out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitize(raw: unknown): StoredAuth | undefined {
  if (!isRecord(raw)) return undefined
  const account = isRecord(raw.account) ? raw.account : {}
  const auth = isRecord(raw.auth) ? raw.auth : {}
  const token = typeof auth.token === 'string' ? auth.token.trim() : ''
  if (!token) return undefined
  const id = typeof account.id === 'string' && account.id.trim() ? account.id.trim() : 'default'
  const savedAt = typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : Date.now()
  const extraHeaders = sanitizeHeaders(auth.extraHeaders)
  const userId = typeof raw.userId === 'string' ? raw.userId.trim() : ''
  return {
    version: 1,
    account: {
      id,
      ...(typeof account.displayName === 'string' && account.displayName.trim()
        ? { displayName: account.displayName.trim() }
        : {}),
    },
    auth: {
      token,
      ...(typeof auth.cookie === 'string' && auth.cookie ? { cookie: auth.cookie } : {}),
      ...(typeof auth.hifDliq === 'string' && auth.hifDliq ? { hifDliq: auth.hifDliq } : {}),
      ...(typeof auth.hifLeim === 'string' && auth.hifLeim ? { hifLeim: auth.hifLeim } : {}),
      ...(typeof auth.clientVersion === 'string' && auth.clientVersion
        ? { clientVersion: auth.clientVersion }
        : {}),
      ...(typeof auth.userAgent === 'string' && auth.userAgent ? { userAgent: auth.userAgent } : {}),
      ...(extraHeaders ? { extraHeaders } : {}),
      ...(typeof auth.wasmUrl === 'string' && auth.wasmUrl ? { wasmUrl: auth.wasmUrl } : {}),
    },
    ...(userId ? { userId } : {}),
    savedAt,
  }
}

/** 读取凭证；文件缺失/损坏/无 token 均返回 undefined（等价未登录）。 */
export function readAuth(env: NodeJS.ProcessEnv = process.env): StoredAuth | undefined {
  const file = authPath(env)
  try {
    if (!existsSync(file)) return undefined
    return sanitize(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return undefined
  }
}

/** 原子保存凭证；目录不存在则创建。 */
export function saveAuth(auth: StoredAuth, env: NodeJS.ProcessEnv = process.env): void {
  const checked = sanitize(auth)
  if (!checked) throw new Error('freetoken: refusing to save an empty credential')
  const file = authPath(env)
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(temp, `${JSON.stringify(checked, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

/** 清除凭证；返回是否删除了文件。 */
export function clearAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = authPath(env)
  try {
    if (!existsSync(file)) return false
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}

/** 掩码：仅保留首尾 4 字符；用于日志/状态展示。 */
export function maskToken(token: string): string {
  const value = String(token ?? '')
  if (value.length <= 8) return '****'
  return `${value.slice(0, 4)}****${value.slice(-4)}`
}
