/**
 * 队列在飞计数（M11 / queue.maxPending）。
 * 超限时 fail-fast（调用方返回明确错误），不无限堆叠。
 */

export class PendingQueue {
  private readonly maxPending: number
  private current = 0
  private rejected = 0

  constructor(options: { maxPending: number }) {
    this.maxPending = Math.max(1, Math.round(options.maxPending))
  }

  /** 尝试进入；已满返回 false（调用方据此快速失败）。 */
  tryEnter(): boolean {
    if (this.current >= this.maxPending) {
      this.rejected += 1
      return false
    }
    this.current += 1
    return true
  }

  leave(): void {
    this.current = Math.max(0, this.current - 1)
  }

  size(): number {
    return this.current
  }

  isFull(): boolean {
    return this.current >= this.maxPending
  }

  stats(): { pending: number; maxPending: number; rejected: number } {
    return { pending: this.current, maxPending: this.maxPending, rejected: this.rejected }
  }
}
