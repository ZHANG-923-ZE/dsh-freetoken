/**
 * 凭证连续性（纯函数，不碰文件/网络/浏览器）。
 *
 * 背景（2026-10-20 现场）：网页端 token/cookie 会轮换，插件把**静态快照** auth.json
 * 当成唯一事实来源 ⇒ ① 页面自己换新 token 后，插件下一次请求又拿旧 token 装回页面
 * （把页面从“已登录”降级成“token 失效”）；② 一旦某次请求 401，后续请求继续用旧快照，
 * 登录态就表现为“运行中突然断掉”，只能人工 `/freetoken login`。
 *
 * 这里的判据全部是纯函数，真实链路只负责调用，方便离线用例反向验证。
 */

import type { StoredAuth } from './auth.js'

export const SITE_ORIGIN = 'https://chat.deepseek.com'

/** 页面读取到的登录态（来源：传输层浏览器 localStorage / 命令回执）。 */
export interface PageCredentialView {
  token?: string
  cookie?: string
  userId?: string
  displayName?: string
}

/** 可用 token 的下限与 vendor `hasUsableAuth` 同口径（`token.length > 8`）。 */
export function usableToken(value: unknown): string {
  const token = typeof value === 'string' ? value.trim() : ''
  return token.length > 8 ? token : ''
}

/** URL 是不是站点自己的 origin（只有站点页面里的 token 才可信）。 */
export function isSiteOriginUrl(url: unknown): boolean {
  try {
    return new URL(String(url ?? '')).origin === SITE_ORIGIN
  } catch {
    return false
  }
}

/**
 * 把页面里的“当前有效凭证”合并进 auth.json 快照。
 *
 * 红线：
 *  - **只在页面有可用 token 时采纳 token/cookie**；页面 token 为空（被站点登出）
 *    绝不覆盖快照 —— 否则一次页面登出会把唯一还能用的凭证抹掉。
 *  - 页面 token 与快照不同即采纳（页面是站点自己维护的活状态；登录后重装页面由
 *    `resetCredentialSession` 保证不会把旧页面的 token 当新的）。
 *  - 身份（userId/displayName）只补不丢：页面里读到就回填，快照里已有则保留。
 *  - `savedAt` 只在 token/cookie 真的变化时更新（它表示“凭证快照的采集时刻”）。
 *
 * @returns 发生实际变化时返回新快照；无变化返回 undefined（调用方不写盘）。
 */
export function adoptPageCredential(
  current: StoredAuth,
  page: PageCredentialView | null | undefined,
): StoredAuth | undefined {
  if (!page) return undefined

  const token = usableToken(page.token)
  const cookie = typeof page.cookie === 'string' ? page.cookie : ''
  const userId = typeof page.userId === 'string' ? page.userId.trim() : ''
  const displayName = typeof page.displayName === 'string' ? page.displayName.trim() : ''

  const tokenChanged = Boolean(token) && token !== current.auth.token
  const cookieChanged = Boolean(cookie) && cookie !== (current.auth.cookie ?? '')
  const userIdChanged = Boolean(userId) && userId !== current.userId
  const displayChanged = Boolean(displayName) && displayName !== current.account.displayName

  if (!tokenChanged && !cookieChanged && !userIdChanged && !displayChanged) return undefined

  return {
    version: 1,
    account: {
      ...current.account,
      ...(displayChanged ? { displayName } : {}),
    },
    auth: {
      ...current.auth,
      ...(tokenChanged ? { token } : {}),
      ...(cookieChanged ? { cookie } : {}),
    },
    ...(userIdChanged ? { userId } : {}),
    savedAt: tokenChanged || cookieChanged ? Date.now() : current.savedAt,
  }
}

/** 探活/登录失败的两种性质：凭证本身失效（必须重登） vs 网络/服务瞬时抖动（不该报断线）。 */
export type CredentialFailureKind = 'auth' | 'transient'

/**
 * 判断一条失败说明是不是**授权类**失败。
 *
 * 判据与 vendor `isAuthFailureMessage` 保持同一白名单（认不出来一律当瞬时抖动）：
 * 认错的代价不对等 —— 把网络抖动当“登录失效”会让面板误报“未登录”，
 * 把授权失败当抖动则只是多试一次。
 */
export function classifyCredentialFailure(message: unknown): CredentialFailureKind {
  const text = String(message ?? '')
  if (!text) return 'transient'
  if (/authorization failed|invalid token|unauthori[sz]ed/i.test(text)) return 'auth'
  if (/授权失败|missing credential|not logged in/i.test(text)) return 'auth'
  if (/登录(态|状态)?[^。；;]{0,8}(过期|失效|无效)/.test(text)) return 'auth'
  // 明确的状态码形态：只认 "HTTP 401/403"，不认裸数字（与 vendor 同判据）。
  return /HTTP\s*40[13]\b/i.test(text) ? 'auth' : 'transient'
}

/**
 * 本轮 AUTH 能不能再做一次“自动续签后重试”。
 *
 * 只允许：第一次尝试（attempt=0）且**尚未吐出任何正文/思考内容**。
 * 已经产出内容后再重试会重复回答，宁可让本轮失败由宿主重试。
 */
export function canAttemptAuthRecovery(state: {
  attempt: number
  contentEmitted: boolean
}): boolean {
  return state.attempt === 0 && state.contentEmitted === false
}

/**
 * 把本插件的单账号凭证转成 vendor `WebAuth` 形状（含稳定身份 `user.id`）。
 *
 * `unverified: true` 保持原语义（快照来自登录捕获，未经每次请求校验）。
 */
export function toWebAuthShape(auth: StoredAuth): any {
  const userId = typeof auth.userId === 'string' && auth.userId ? auth.userId : ''
  const display = auth.account?.displayName
  return {
    token: auth.auth.token,
    cookie: auth.auth.cookie ?? '',
    hifDliq: auth.auth.hifDliq ?? '',
    hifLeim: auth.auth.hifLeim ?? '',
    wasmUrl: auth.auth.wasmUrl ?? '',
    userAgent: auth.auth.userAgent ?? '',
    ...(auth.auth.extraHeaders ? { extraHeaders: auth.auth.extraHeaders } : {}),
    capturedAt: new Date(auth.savedAt).toISOString(),
    unverified: true,
    ...(userId || display
      ? {
          user: {
            ...(userId ? { id: userId } : {}),
            ...(display ? { display } : {}),
          },
        }
      : {}),
  }
}