/**
 * 登录态只读探活：`GET /api/v0/users/current`（零额度）。
 * 仅用于验证凭证；不改动服务端状态。网络/超时/5xx 不判死，只回报 ok=false。
 */

import type { StoredAuth } from './auth.js'

export const DS_BASE = 'https://chat.deepseek.com'

export interface ProbeResult {
  ok: boolean
  status?: number
  error?: string
  user?: { id?: string; display?: string }
}

function headersFor(auth: StoredAuth): Record<string, string> {
  const credential = auth.auth
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${credential.token}`,
  }
  if (credential.cookie) headers.cookie = credential.cookie
  if (credential.hifDliq) headers['x-hif-dliq'] = credential.hifDliq
  if (credential.hifLeim) headers['x-hif-leim'] = credential.hifLeim
  if (credential.userAgent) headers['user-agent'] = credential.userAgent
  return headers
}

/**
 * 探活一次凭证。
 * @param auth 已存凭证
 * @param fetchImpl 可注入（测试用）；默认每次现取 globalThis.fetch，避免固化桩件失效。
 */
export async function probeAuth(
  auth: StoredAuth,
  fetchImpl?: typeof fetch,
): Promise<ProbeResult> {
  if (!auth?.auth?.token) return { ok: false, error: 'missing token' }
  const doFetch = fetchImpl ?? ((input: any, init?: any) => fetch(input, init))
  let response: Response
  try {
    response = await doFetch(`${DS_BASE}/api/v0/users/current`, {
      method: 'GET',
      headers: headersFor(auth),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error: any) {
    return { ok: false, error: `network: ${error?.name === 'TimeoutError' ? 'timeout' : String(error?.message ?? error)}` }
  }

  const text = await response.text().catch(() => '')
  if (!response.ok) {
    return { ok: false, status: response.status, error: `HTTP ${response.status}${text ? `: ${text.slice(0, 120)}` : ''}` }
  }
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, status: response.status, error: 'non-JSON response' }
  }
  const code = Number(json?.code ?? 0)
  if (Number.isFinite(code) && code !== 0) {
    return { ok: false, status: response.status, error: `biz code ${code}: ${String(json?.msg ?? '').slice(0, 120)}` }
  }
  // HTTP 200 也可能是“授权失败信封”（`{code:0,data:{biz_code:40003,biz_msg:...}}`）。
  // 不认这一层的话，登录后的零额度探活会**假通过**，而且用户身份永远不回填。
  const data = json?.data
  const bizCode = Number(data?.biz_code ?? data?.biz_data?.biz_code ?? 0)
  const bizMsg = String(data?.biz_msg ?? data?.biz_data?.biz_msg ?? '')
  if (
    bizCode === 40003 ||
    bizCode === 40001 ||
    /authorization failed|invalid token|unauthori[sz]ed/i.test(bizMsg) ||
    /授权失败|登录(态|状态)?[^。；;]{0,8}(过期|失效|无效)/.test(bizMsg)
  ) {
    return {
      ok: false,
      status: response.status,
      error: `biz code ${bizCode || 'AUTH'}: ${bizMsg || 'authorization failed'}`,
    }
  }
  if (Number.isFinite(bizCode) && bizCode !== 0) {
    return { ok: false, status: response.status, error: `biz code ${bizCode}: ${bizMsg.slice(0, 120)}` }
  }
  // 身份形态兼容：`data.biz_data.user` / `data.user` / `data.biz_data`；id 允许数字。
  const bizData = data?.biz_data ?? data
  const user = bizData?.user ?? data?.user ?? bizData
  const rawId = user?.id ?? user?.user_id ?? user?.userId
  const id = rawId === undefined || rawId === null ? '' : String(rawId)
  const display = user?.display_name ?? user?.name ?? user?.email ?? user?.display
  return {
    ok: true,
    status: response.status,
    ...(id || typeof display === 'string'
      ? {
          user: {
            ...(id ? { id } : {}),
            ...(typeof display === 'string' && display ? { display } : {}),
          },
        }
      : {}),
  }
}
