/**
 * DSH 会话 ↔ 网页会话映射（P2.1/P2.2）。
 *
 * Harness 会话为主、网页会话为从：每个 `GenerateOptions.sessionId` 一个槽，
 * 槽内记录网页端 sessionId、复用轮数与更新时间。重启后可恢复，绝不把两个
 * Harness 会话混进同一个网页会话。
 *
 * 只存映射元数据，不存任何凭证。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { freetokenPath } from '../transport/paths.js'

export interface SessionSlot {
  dshSessionId: string
  webSessionId: string
  turns: number
  updatedAt: number
}

interface PersistedState {
  version: 1
  slots: Record<string, SessionSlot>
}

export interface SessionStoreOptions {
  /** 覆盖路径（测试用）；默认 `<DSH_HOME>/freetoken/sessions.json`。 */
  file?: string
  /** 同屏最多保留多少个槽；超出淘汰最久未用（不删除网页会话）。 */
  maxSlots?: number
  now?: () => number
}

export function sessionsPath(env: NodeJS.ProcessEnv = process.env): string {
  return freetokenPath('sessions.json', env)
}

export class SessionStore {
  private readonly file: string
  private readonly maxSlots: number
  private readonly now: () => number
  private slots = new Map<string, SessionSlot>()

  constructor(options: SessionStoreOptions = {}) {
    this.file = options.file ?? sessionsPath()
    this.maxSlots = Math.max(1, Math.round(options.maxSlots ?? 6))
    this.now = options.now ?? (() => Date.now())
    this.load()
  }

  /** 读取映射；不存在返回 undefined。 */
  get(dshSessionId: string): SessionSlot | undefined {
    return this.slots.get(dshSessionId)
  }

  /**
   * 申请一次租约：槽存在且未到轮换轮数则复用并计数；否则返回 undefined，
   * 调用方应创建新的网页会话后调用 `record()`。
   */
  lease(dshSessionId: string, reuseTurns: number): SessionSlot | undefined {
    const slot = this.slots.get(dshSessionId)
    if (!slot) return undefined
    const limit = Number.isFinite(reuseTurns) ? Math.max(0, Math.floor(reuseTurns)) : 0
    if (limit === 0 || slot.turns >= limit) return undefined
    slot.turns += 1
    slot.updatedAt = this.now()
    this.save()
    return { ...slot }
  }

  /** 记录一个新网页会话（新 Harness 会话首轮 / 轮换后）。 */
  record(dshSessionId: string, webSessionId: string): SessionSlot {
    const slot: SessionSlot = {
      dshSessionId,
      webSessionId,
      turns: 1,
      updatedAt: this.now(),
    }
    this.slots.set(dshSessionId, slot)
    this.evict()
    this.save()
    return { ...slot }
  }

  /** 退役一个映射（网页会话失效时调用）。 */
  retire(dshSessionId: string): boolean {
    const removed = this.slots.delete(dshSessionId)
    if (removed) this.save()
    return removed
  }

  /** 当前快照（按最近使用倒序）。 */
  snapshot(): SessionSlot[] {
    return [...this.slots.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((slot) => ({ ...slot }))
  }

  private evict(): void {
    if (this.slots.size <= this.maxSlots) return
    const oldest = [...this.slots.values()].sort((a, b) => a.updatedAt - b.updatedAt)
    for (const slot of oldest.slice(0, this.slots.size - this.maxSlots)) {
      this.slots.delete(slot.dshSessionId)
    }
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as PersistedState
      if (raw?.version !== 1 || typeof raw.slots !== 'object' || raw.slots === null) return
      for (const [key, value] of Object.entries(raw.slots)) {
        if (
          value &&
          typeof value === 'object' &&
          typeof value.dshSessionId === 'string' &&
          typeof value.webSessionId === 'string' &&
          value.webSessionId.length > 0
        ) {
          this.slots.set(key, {
            dshSessionId: value.dshSessionId,
            webSessionId: value.webSessionId,
            turns: Number.isInteger(value.turns) && value.turns > 0 ? value.turns : 1,
            updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : this.now(),
          })
        }
      }
    } catch {
      // 损坏文件按空映射处理（下次写入重建），绝不因此让调用失败
      this.slots.clear()
    }
  }

  private save(): void {
    const state: PersistedState = { version: 1, slots: Object.fromEntries(this.slots) }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`)
      renameSync(temp, this.file)
    } catch {
      // 落盘失败不阻塞请求；内存映射继续可用
    }
  }
}
