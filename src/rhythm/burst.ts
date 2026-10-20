/**
 * 每 turn 工具调用上限（R/D15）。
 *
 * 适配器无法强制 DSH 拆 turn，因此这里只做**计数与违约标记**：超过上限时由
 * RhythmController 施加更长间隔/静默，绝不静默丢弃调用（丢调用 = 吞掉工具执行）。
 */

export interface BurstObservation {
  turnKey: string
  count: number
  exceeded: boolean
}

export class BurstTracker {
  private readonly maxCalls: number
  private readonly counts = new Map<string, number>()

  constructor(options: { maxCalls: number }) {
    this.maxCalls = Math.max(1, Math.round(options.maxCalls))
  }

  /** 记录一次工具调用发射；返回该 turn 的累计与是否超限。 */
  observe(turnKey: string): BurstObservation {
    const key = String(turnKey || 'unknown')
    const count = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, count)
    return { turnKey: key, count, exceeded: count > this.maxCalls }
  }

  /** 本 turn 已计数。 */
  countOf(turnKey: string): number {
    return this.counts.get(String(turnKey || 'unknown')) ?? 0
  }

  /** turn 结束/切换时清理（避免 Map 无界增长）。 */
  reset(turnKey?: string): void {
    if (turnKey === undefined) this.counts.clear()
    else this.counts.delete(String(turnKey || 'unknown'))
  }

  /** 已跟踪的 turn 数（诊断用）。 */
  size(): number {
    return this.counts.size
  }
}
