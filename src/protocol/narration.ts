/**
 * `<narration>` 拆分 + 本地讲解模板（P3.1/P3.2）。
 *
 * 模型在同一次响应里输出 `<narration>done: …; next: …</narration>`；
 * 本地拆分，narration 走 reasoning/旁白，正文去掉该块。解析失败不回请求，
 * 由调用方降级到 `localNarration()` 模板。
 */

export interface NarrationSplit {
  narration: string | null
  /** 去掉 narration 块后的正文。 */
  text: string
}

const NARRATION_RE = /<narration>([\s\S]*?)<\/narration>/i

export function splitNarration(raw: string): NarrationSplit {
  const text = String(raw ?? '')
  const match = NARRATION_RE.exec(text)
  if (!match) return { narration: null, text }
  const narration = (match[1] ?? '').trim()
  const rest = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`
  return { narration: narration.length > 0 ? narration : null, text: rest.replace(/\n{3,}/g, '\n\n').trim() }
}

export interface LocalNarrationInput {
  mergedCalls?: number
  parseFailures?: number
  retryPlan?: string
  queuePending?: number
  etaMs?: number
  phase?: string
  todayRequests?: number
  lastSilenceReason?: string
}

/**
 * 本地讲解模板（纯本地，绝不发往网页端）。
 * 只描述可观测事实；缺省字段不编造。
 */
export function localNarration(input: LocalNarrationInput): string {
  const parts: string[] = []
  if (input.mergedCalls !== undefined) parts.push(`本轮合并 ${input.mergedCalls} 个调用`)
  if (input.parseFailures !== undefined) parts.push(`解析失败 ${input.parseFailures} 项`)
  if (input.retryPlan) parts.push(input.retryPlan)
  if (input.queuePending !== undefined) {
    const eta = input.etaMs !== undefined ? `，预计 ${Math.max(0, Math.round(input.etaMs / 1000))}s 后发送` : ''
    parts.push(`队列待发 ${input.queuePending} 项${eta}`)
  }
  if (input.phase) parts.push(`节奏阶段 ${input.phase}`)
  if (input.todayRequests !== undefined) parts.push(`今日已发 ${input.todayRequests} 次`)
  if (input.lastSilenceReason) parts.push(`最近静默原因 ${input.lastSilenceReason}`)
  return parts.length > 0 ? `[freetoken] ${parts.join('；')}` : '[freetoken] 空闲'
}
