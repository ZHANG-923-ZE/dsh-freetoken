/**
 * 可观测性计数（M16/M15 指标）：请求数、标题节省、单飞复用、拆批、部分失败、
 * 队列等待/批大小分位。只保留最近 200 个样本，避免无界增长。
 */

const SAMPLE_LIMIT = 200

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!
}

export class Metrics {
  private data = {
    requests: 0,
    titleSaved: 0,
    coalesced: 0,
    batchSplit: 0,
    partialFailure: 0,
  }
  private queueWaits: number[] = []
  private batchSizes: number[] = []

  recordRequest(): void {
    this.data.requests += 1
  }

  recordTitleSaved(): void {
    this.data.titleSaved += 1
  }

  recordCoalesced(): void {
    this.data.coalesced += 1
  }

  recordBatchSplit(): void {
    this.data.batchSplit += 1
  }

  recordPartialFailure(): void {
    this.data.partialFailure += 1
  }

  recordQueueWait(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return
    this.trim(this.queueWaits).push(ms)
  }

  recordBatchSize(count: number): void {
    if (!Number.isInteger(count) || count <= 0) return
    this.trim(this.batchSizes).push(count)
  }

  private trim(list: number[]): number[] {
    if (list.length >= SAMPLE_LIMIT) list.shift()
    return list
  }

  snapshot() {
    return {
      ...this.data,
      queueWaitMsMedian: median(this.queueWaits),
      batchSizeMedian: median(this.batchSizes),
      samples: this.queueWaits.length,
    }
  }
}
