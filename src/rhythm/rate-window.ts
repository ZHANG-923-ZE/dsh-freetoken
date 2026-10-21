/**
 * 滚动窗口限速 + 连续请求长休（S3.1 / 2026-10-21）。
 *
 * ## 为什么单独实现，而不是复用 vendor 的 `gate.ts`
 *
 * `vendor/gate.ts` 的 `createRequestGate()` 确实实现了这两条，但它**同时**自带
 * 串行队列与间隔控制 —— 而本插件已有 `SerialLock` + jitter + minRequestGapMs。
 * 直接接入会变成两层队列：一次请求要等两个闸门，行为难推理、出问题难归因。
 *
 * 这里只补**本插件缺失的两条保护**，纯计数逻辑，不碰调度：
 *
 * 1. **滚动窗口限速**：任意 `windowMs` 内最多 `maxInWindow` 次。
 *    比"日预算"精细 —— 日预算只防总量，防不住"7 次挤在 3 分钟"（2026-10-20 封禁的真实形态）。
 * 2. **连续请求长休**：连续 N 次之后强制休 `breakMs`。
 *    "连续跑 N 次、每次间隔很短"比"总请求数多"更像脚本，这是对形态的直接约束。
 *
 * 时间与随机源可注入，离线用例不依赖真实定时器。
 */

export interface RateWindowOptions {
  /** 窗口长度（ms）。<=0 表示关闭。 */
  windowMs: number
  /** 窗口内最多多少次。<=0 表示关闭。 */
  maxInWindow: number
  now?: () => number
}

export interface RateWindowSnapshot {
  /** 窗口内已计次数。 */
  count: number
  /** 达到上限时还要等多久才有配额（ms）；0 = 现在就能发。 */
  waitMs: number
}

/**
 * 滚动窗口计数器。
 *
 * 语义：`record()` 只记录**真正发出去**的请求（不含被静默/预算拦下的），
 * 这样窗口计数与站点看到的一致。
 */
export class RateWindow {
  private readonly windowMs: number
  private readonly maxInWindow: number
  private readonly now: () => number
  /** 窗口内的请求时刻，升序。 */
  private starts: number[] = []

  constructor(options: RateWindowOptions) {
    this.windowMs = Math.max(0, Math.round(options.windowMs))
    this.maxInWindow = Math.max(0, Math.round(options.maxInWindow))
    this.now = options.now ?? (() => Date.now())
  }

  get enabled(): boolean {
    return this.windowMs > 0 && this.maxInWindow > 0
  }

  /** 剪掉滑出窗口的旧记录。 */
  private prune(now: number): void {
    if (this.starts.length === 0) return
    const cutoff = now - this.windowMs
    // 升序数组：找到第一个 > cutoff 的位置即可整体切掉前缀
    let index = 0
    while (index < this.starts.length && this.starts[index] <= cutoff) index += 1
    if (index > 0) this.starts = this.starts.slice(index)
  }

  /** 现在能不能发；不能则给出需要等待的毫秒数。 */
  check(): RateWindowSnapshot {
    if (!this.enabled) return { count: 0, waitMs: 0 }
    const now = this.now()
    this.prune(now)
    if (this.starts.length < this.maxInWindow) {
      return { count: this.starts.length, waitMs: 0 }
    }
    // 配额满：要等最早那条滑出窗口，才有位置
    const oldest = this.starts[0] as number
    const waitMs = Math.max(0, this.windowMs - (now - oldest))
    return { count: this.starts.length, waitMs }
  }

  /** 记录一次真实发出的请求。 */
  record(): void {
    if (!this.enabled) return
    const now = this.now()
    this.starts.push(now)
    this.prune(now)
  }

  /** 诊断用。 */
  snapshot(): RateWindowSnapshot {
    return this.check()
  }

  /** 用例用：清空。 */
  reset(): void {
    this.starts = []
  }
}

export interface LongRunOptions {
  /** 连续多少次后触发长休。<=0 表示关闭。 */
  threshold: number
  /** 长休时长区间（ms）。 */
  breakMs: { min: number; max: number }
  random?: () => number
}

export interface LongRunDecision {
  /** 是否该长休。 */
  shouldBreak: boolean
  /** 长休时长（ms，仅 shouldBreak 时有意义）。 */
  breakMs: number
}

/**
 * 连续请求计数与长休判定。
 *
 * 口径：`observe()` 每发一次请求 +1；判定触发时返回长休时长并**归零**
 * （休完重新开始计数，避免"跑满阈值后每次都要长休"）。
 */
export class LongRunGuard {
  private readonly threshold: number
  private readonly minBreak: number
  private readonly maxBreak: number
  private readonly random: () => number
  private consecutive = 0

  constructor(options: LongRunOptions) {
    this.threshold = Math.max(0, Math.round(options.threshold))
    const min = Math.max(0, Math.round(options.breakMs.min))
    const max = Math.max(min, Math.round(options.breakMs.max))
    this.minBreak = min
    this.maxBreak = max
    this.random = options.random ?? Math.random
  }

  get enabled(): boolean {
    return this.threshold > 0
  }

  /** 当前连续次数（诊断用）。 */
  get count(): number {
    return this.consecutive
  }

  /** 记录一次真实请求；返回本次之后是否该长休。 */
  observe(): LongRunDecision {
    if (!this.enabled) return { shouldBreak: false, breakMs: 0 }
    this.consecutive += 1
    if (this.consecutive < this.threshold) return { shouldBreak: false, breakMs: 0 }
    this.consecutive = 0
    const span = this.maxBreak - this.minBreak
    const ms = span <= 0 ? this.minBreak : this.minBreak + Math.round(span * this.random())
    return { shouldBreak: true, breakMs: ms }
  }

  /** 用例用：清空。 */
  reset(): void {
    this.consecutive = 0
  }
}