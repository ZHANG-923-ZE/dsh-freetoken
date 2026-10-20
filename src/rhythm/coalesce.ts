/**
 * 相同请求 single-flight（L3）：相同 key 的并发调用只执行一次任务，共享结果。
 * key 由调用方构造（provider/model/purpose/sessionId/promptHash/toolsHash）。
 */

export interface SingleFlightStats {
  inflight: number
  joined: number
}

export class SingleFlight<T> {
  private readonly tasks = new Map<string, Promise<T>>()
  private joined = 0

  /** 执行或加入一个同 key 的在飞任务。 */
  run(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.tasks.get(key)
    if (existing) {
      this.joined += 1
      return existing
    }
    const created = (async () => task())().finally(() => {
      this.tasks.delete(key)
    })
    this.tasks.set(key, created)
    return created
  }

  stats(): SingleFlightStats {
    return { inflight: this.tasks.size, joined: this.joined }
  }
}

/** 稳定 key：字段缺失以空串占位，避免 undefined 造成 key 分裂。 */
export function coalesceKey(parts: {
  provider?: string
  model?: string
  purpose?: string
  sessionId?: string
  promptHash?: string
  toolsHash?: string
}): string {
  return [
    parts.provider ?? '',
    parts.model ?? '',
    parts.purpose ?? 'chat',
    parts.sessionId ?? '',
    parts.promptHash ?? '',
    parts.toolsHash ?? '',
  ].join('|')
}
