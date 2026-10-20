/**
 * 凭证年龄预检（S1.3，2026-10-20）。
 *
 * ## 为什么需要
 *
 * 网页端 token 的寿命约 100 分钟–2 小时（基座 `cookies.ts`/`webapi.ts` 的实测结论：
 * 站点不自续、只能靠重新登录）。现状是**等到 401 才发现**——而那通常发生在一次
 * 长任务的中途，用户看到的是“任务跑到一半突然断”。
 *
 * 本模块只做**判据**：在请求发出前根据 `auth.json` 的 `savedAt` 判断“该不该先续签”。
 * 真正的续签动作仍由 real-backend 走既有页面续签路径（零额外出网：重载页面即可让
 * 站点自己换 token）。这样把“被动 401”改成“主动续期”。
 *
 * 纯函数：不读写文件、不碰网络，便于离线反向验证。
 */

/** 默认阈值：90 分钟。低于实测寿命（100 分钟）留出余量，又不会每轮都触发续签。 */
export const DEFAULT_REFRESH_AGE_MS = 90 * 60 * 1000

export interface CredentialAgeInput {
  /** `auth.json` 的保存时刻（ms）。缺失/非法按“未知”处理。 */
  savedAt: number | null | undefined
  /** 当前时刻（ms）。 */
  now: number
  /** 阈值（ms）；<=0 表示关闭预检。 */
  thresholdMs: number
}

export type CredentialAgeVerdict =
  /** 凭证还年轻，正常发请求。 */
  | 'fresh'
  /** 超过阈值，建议先续签再发（避免在任务中途撞 401）。 */
  | 'due'
  /** 时间戳未知/非法：不主动续签（宁可照旧发一次，也不做无依据的动作）。 */
  | 'unknown'
  /** 预检被关闭（thresholdMs <= 0）。 */
  | 'disabled'

/** 计算凭证年龄（ms）；未知返回 null。 */
export function credentialAgeMs(
  savedAt: number | null | undefined,
  now: number,
): number | null {
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt) || savedAt <= 0) return null
  if (typeof now !== 'number' || !Number.isFinite(now)) return null
  // 时钟回拨（现在早于保存时刻）按 0 处理：不做“负数年龄 ⇒ 永不过期”的危险推断。
  return Math.max(0, now - savedAt)
}

/**
 * 判据入口。
 *
 * ⚠️ 只在**真的快到寿命**时返回 `due`：把阈值设小会让每个请求都先重载页面，
 * 那既慢又更不像真人（每个请求都触发一次整页加载）。
 */
export function evaluateCredentialAge(input: CredentialAgeInput): CredentialAgeVerdict {
  const threshold = Number(input.thresholdMs)
  if (!Number.isFinite(threshold) || threshold <= 0) return 'disabled'
  const age = credentialAgeMs(input.savedAt, input.now)
  if (age === null) return 'unknown'
  return age >= threshold ? 'due' : 'fresh'
}

/** 给日志/面板用的一句话（不含凭证内容）。 */
export function describeCredentialAge(age: number | null): string {
  if (age === null) return '凭证年龄未知'
  const minutes = Math.floor(age / 60_000)
  if (minutes < 1) return '凭证刚刷新'
  if (minutes < 60) return `凭证已用 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `凭证已用 ${hours} 小时${rest > 0 ? ` ${rest} 分钟` : ''}`
}