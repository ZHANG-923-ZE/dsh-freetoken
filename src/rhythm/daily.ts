/**
 * 日预算（R16 / D14）：按本地自然日计数，跨零点自动归零。
 * budget = 0 表示不设上限。now 可注入，便于离线验证跨日重置。
 */

export interface DailyBudgetOptions {
  budget: number
  now?: () => number
  /** 启动时从磁盘恢复的今日已发数（跨重启累计，防止重启绕过日预算）。 */
  initialCount?: number
}

export interface DailySnapshot {
  dayKey: string
  todayRequests: number
  dailyBudget: number
  resetAt: number
}

function dayKeyOf(timestamp: number): string {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function nextMidnight(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(24, 0, 0, 0)
  return date.getTime()
}

export class DailyBudget {
  private readonly budget: number
  private readonly now: () => number
  private dayKey: string
  private count = 0

  constructor(options: DailyBudgetOptions) {
    this.budget = Math.max(0, Math.round(options.budget))
    this.now = options.now ?? (() => Date.now())
    this.dayKey = dayKeyOf(this.now())
    this.count = Math.max(0, Math.floor(options.initialCount ?? 0))
  }

  /** 跨日重置（惰性；每次访问先对齐日期）。 */
  private roll(): void {
    const key = dayKeyOf(this.now())
    if (key !== this.dayKey) {
      this.dayKey = key
      this.count = 0
    }
  }

  /** 0 = 不限；返回今日剩余可发送次数（不限时为 Infinity）。 */
  remaining(): number {
    this.roll()
    return this.budget === 0 ? Number.POSITIVE_INFINITY : Math.max(0, this.budget - this.count)
  }

  canSend(): boolean {
    return this.remaining() > 0
  }

  /** 记录一次实际发出的网页请求。 */
  record(): void {
    this.roll()
    this.count += 1
  }

  snapshot(): DailySnapshot {
    this.roll()
    return {
      dayKey: this.dayKey,
      todayRequests: this.count,
      dailyBudget: this.budget,
      resetAt: nextMidnight(this.now()),
    }
  }
}
