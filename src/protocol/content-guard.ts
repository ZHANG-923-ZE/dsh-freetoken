/**
 * 内容守卫（R17 / D27 / D28）：
 *  - narration 去重：同一段旁白在窗口内重复超过上限就折叠（只计数，不上屏）。
 *  - 探接口式问法拦截：协议指令里明确禁止；本地对用户 prompt 做一次轻量检测，
 *    命中时只在日志/status 里提示，不改写用户消息（不静默篡改用户输入）。
 */

export interface NarrationDedupeOptions {
  windowMs?: number
  maxRepeats?: number
  now?: () => number
}

export interface NarrationDecision {
  /** 可上屏的旁白；被折叠时为 null。 */
  text: string | null
  /** 是否因为重复被折叠。 */
  suppressed: boolean
}

/** narration 去重器：窗口内相同文本最多出现 maxRepeats 次。 */
export class NarrationDeduper {
  private readonly windowMs: number
  private readonly maxRepeats: number
  private readonly now: () => number
  private readonly seen = new Map<string, number[]>()
  private suppressed = 0

  constructor(options: NarrationDedupeOptions = {}) {
    this.windowMs = Math.max(0, options.windowMs ?? 90_000)
    this.maxRepeats = Math.max(0, options.maxRepeats ?? 2)
    this.now = options.now ?? (() => Date.now())
  }

  record(text: string): NarrationDecision {
    const value = String(text ?? '').trim()
    if (!value) return { text: null, suppressed: false }
    const now = this.now()
    const list = (this.seen.get(value) ?? []).filter((at) => now - at < this.windowMs)
    if (list.length >= this.maxRepeats) {
      this.seen.set(value, list)
      this.suppressed += 1
      return { text: null, suppressed: true }
    }
    list.push(now)
    this.seen.set(value, list)
    return { text: value, suppressed: false }
  }

  get suppressedCount(): number {
    return this.suppressed
  }
}

/**
 * 探接口式问法检测（R17）。
 *
 * 只做“提示”，不做改写：用户明确要求解释接口时，插件不能替用户改问题；
 * 协议指令负责约束**模型**不要主动探接口。
 */
const PROBING_PATTERNS: readonly RegExp[] = [
  /你(是|用的)(什么|哪个)模型/,
  /你(的)?(接口|api|endpoint|系统提示词|prompt)/i,
  /what\s+model\s+are\s+you/i,
  /what('s| is) your (api|endpoint|system prompt)/i,
]

export function looksLikeProbingQuestion(text: string): boolean {
  const value = String(text ?? '')
  return PROBING_PATTERNS.some((pattern) => pattern.test(value))
}