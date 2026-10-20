/**
 * deferred 攒批删除（D7 / P2.4 / M10）。
 *
 * 一次模型调用会建一个临时网页会话。若「用完立刻删」，请求节奏非常像脚本，
 * 所以默认改成攒批：队列每轮随机攒 `batchRange`（默认 6~10）个、或从第一个入队起
 * 等满 `delayRange`（默认 60~120s）再清理；逐个删除之间再停一个随机 `gapRange`
 * （默认 0.8~2.5s）。
 *
 * 账本语义（对齐基座 SessionLifecycleEvent）：
 *  - `schedule()` 落 `queued` 欠账；**只有 deleteSession 返回 true 才摘账**；
 *  - 删除失败/异常 → 账本保留，下一次启动 sweep 再排一次；
 *  - `mode:keep` → 一条都不记、一条都不删（绝不能留下永远删不掉的欠账）；
 *  - `discard()` 只用于我们自己建的脚手架会话：不受策略约束、不 drain 队列。
 *
 * 所有定时器/随机源/删除函数均可注入，离线用例因此完全确定性、不碰真实定时器。
 */

import type { Range } from '../config.js'
import {
  planStartupSweep,
  readJournal,
  removeJournalEntry,
  upsertJournalEntry,
  writeJournal,
} from './journal.js'

export interface CleanupPolicy {
  mode: 'deferred' | 'keep'
  batchRange: Range
  delayRange: Range
  gapRange: Range
}

export interface CleanupStats {
  pending: number
  journalEntries: number
  lastFlushAt: number | null
  deleted: number
  failed: number
}

export interface DeferredCleaner {
  /** 记一个待删会话（deferred 下入队 + 落账）。 */
  schedule(accountId: string, sessionId: string): void
  /** 立即丢弃我们自己的脚手架会话（不受策略约束），返回是否确认删掉。 */
  discard(accountId: string, sessionId: string): Promise<boolean>
  /** 立即清理队列（手动/卸载用）。串行化且幂等。 */
  flush(): Promise<void>
  pendingCount(): number
  stats(): CleanupStats
  /** 启动补扫：读账本 → 决策 → 把该补删的排进队列，返回排入数量。 */
  sweepStartup(): number
  /** 停用：清定时器。账本保留给下次启动补扫。 */
  dispose(): void
}

export interface DeferredCleanerDeps {
  deleteSession: (accountId: string, sessionId: string) => Promise<boolean>
  accountExists?: (id: string) => boolean
  /** 覆盖账本路径（测试用）；默认 `<DSH_HOME>/freetoken/sessions-in-use.json`。 */
  file?: string
  policy: CleanupPolicy
  now?: () => number
  random?: () => number
  setTimeoutImpl?: (fn: () => void, ms: number) => any
  clearTimeoutImpl?: (t: any) => void
  logger?: { info?: (message: string) => void; warn?: (message: string) => void }
}

interface QueueItem {
  accountId: string
  sessionId: string
}

export function createDeferredCleaner(deps: DeferredCleanerDeps): DeferredCleaner {
  const file = deps.file
  const policy = deps.policy
  const now = deps.now ?? (() => Date.now())
  const random = deps.random ?? Math.random
  const setT = deps.setTimeoutImpl ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearT = deps.clearTimeoutImpl ?? ((t: any) => clearTimeout(t))
  const logger = deps.logger
  const deleteSession = deps.deleteSession
  const accountExists = deps.accountExists

  let queue: QueueItem[] = []
  let timer: any
  /** 本轮随机阈值与最长等待：队列由空变非空时重抽（按轮而不是每次，保持节奏稳定）。 */
  let batchSize = 1
  let delayMs = 0
  let disposed = false
  let lastFlushAt: number | null = null
  let deleted = 0
  let failed = 0
  /** 串行化：上一次还没删完时，这一次排在它后面等，避免两轮删除请求交错。 */
  let chain: Promise<void> = Promise.resolve()

  /** 在 [min, max] 里取整数（闭区间）。random 可注入，离线用例可重复。 */
  function pickInt(range: Range): number {
    const lo = Math.min(range.min, range.max)
    const hi = Math.max(range.min, range.max)
    if (!(hi > lo)) return lo
    const value = random()
    const safe = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
    return Math.min(hi, lo + Math.floor(safe * (hi - lo + 1)))
  }

  function rollCycle(): void {
    batchSize = Math.max(1, pickInt(policy.batchRange))
    delayMs = Math.max(0, pickInt(policy.delayRange))
  }

  /** 用注入的定时器睡一会儿（离线用例里就是「等假表被触发」）。 */
  function sleep(ms: number): Promise<void> {
    if (!(ms > 0)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const handle = setT(() => resolve(), ms)
      ;(handle as any)?.unref?.()
    })
  }

  function clearTimer(): void {
    if (timer === undefined) return
    clearT(timer)
    timer = undefined
  }

  /** 装一次「到点清理」的表（已经装了就不动；keep 模式永不装表）。 */
  function armTimer(): void {
    if (timer !== undefined || disposed) return
    if (policy.mode === 'keep') return
    if (queue.length === 0) return
    timer = setT(() => {
      timer = undefined
      void flush()
    }, Math.max(0, delayMs))
    ;(timer as any)?.unref?.()
  }

  /**
   * 真正干活。开始时清表并整体取走队列；删除确认成功才摘账，
   * 失败/抛错保留账本（下次启动补删）。
   */
  async function doFlush(): Promise<void> {
    clearTimer()
    const batch = queue
    queue = []
    if (batch.length === 0) return
    try {
      for (let i = 0; i < batch.length; i += 1) {
        if (i > 0) {
          const gap = pickInt(policy.gapRange)
          if (gap > 0) await sleep(gap)
        }
        const item = batch[i]
        let ok = false
        try {
          ok = (await deleteSession(item.accountId, item.sessionId)) === true
        } catch (error) {
          logger?.warn?.(`freetoken: 会话删除异常（保留欠账）：${(error as Error)?.message ?? error}`)
        }
        if (ok) {
          removeJournalEntry(item.sessionId, file)
          deleted += 1
          logger?.info?.(`freetoken: 已清理临时会话 ${item.sessionId}`)
        } else {
          failed += 1
          logger?.warn?.(`freetoken: 会话删除未确认，保留欠账 ${item.sessionId}`)
        }
      }
    } finally {
      lastFlushAt = now()
      // 清理期间可能又攒了新的：重新装表，否则它们会一直躺在队列里没人管
      if (queue.length > 0) armTimer()
    }
  }

  function flush(): Promise<void> {
    chain = chain.then(doFlush, doFlush)
    return chain
  }

  function schedule(accountId: string, sessionId: string): void {
    if (disposed) return
    // keep = 用户选择「不删」：一条都不记、一条都不删，避免留下永远删不掉的欠账
    if (policy.mode === 'keep') return
    if (!accountId || !sessionId) return
    // 队列由空变非空 = 新的一轮开始 → 重抽本轮的阈值与最长等待
    if (queue.length === 0) rollCycle()
    queue.push({ accountId, sessionId })
    // 落账：此刻还没删（排着队）。进程被强杀后下次启动据此补删。
    upsertJournalEntry({ accountId, sessionId, pid: process.pid, at: now(), state: 'queued' }, file)
    if (queue.length >= batchSize) {
      void flush()
      return
    }
    armTimer()
  }

  /** 确认删掉（或决定不删）后摘账；失败保留给下次启动。 */
  async function discard(accountId: string, sessionId: string): Promise<boolean> {
    // 只摘掉队列里**同名**项（不 drain 队列），避免随后重复删同一个会话
    const before = queue.length
    queue = queue.filter((item) => item.sessionId !== sessionId)
    if (queue.length < before && queue.length === 0) clearTimer()
    let ok = false
    try {
      ok = (await deleteSession(accountId, sessionId)) === true
    } catch (error) {
      logger?.warn?.(`freetoken: 脚手架会话删除异常：${(error as Error)?.message ?? error}`)
    }
    if (ok) {
      removeJournalEntry(sessionId, file)
      deleted += 1
      logger?.info?.(`freetoken: 已丢弃脚手架会话 ${sessionId}`)
    } else {
      failed += 1
      logger?.warn?.(`freetoken: 脚手架会话删除未确认 ${sessionId}`)
    }
    return ok
  }

  /**
   * 启动补扫：读账本 → 纯决策 → 该补删的排进队列（**不提前摘账**，
   * 要等删除确认）；账号已不存在的记录摘掉（没凭证，永远删不掉）。
   */
  function sweepStartup(): number {
    if (disposed) return 0
    const entries = readJournal(file)
    if (entries.length === 0) return 0
    const plan = planStartupSweep(entries, {
      ownPid: process.pid,
      deleteEnabled: policy.mode !== 'keep',
      mode: policy.mode,
      accountExists,
    })
    let scheduled = 0
    for (const entry of plan.toDelete) {
      try {
        schedule(entry.accountId, entry.sessionId)
        scheduled += 1
      } catch {
        plan.kept.push(entry)
      }
    }
    if (plan.dropped.length > 0) {
      // 只摘掉永远删不掉的；toDelete 仍留在账本里等删除确认
      writeJournal([...plan.kept, ...plan.toDelete], file)
      logger?.info?.(`freetoken: ${plan.dropped.length} 个遗留会话的账号已不存在，无法回收（已从记录移除）`)
    }
    if (scheduled > 0) {
      logger?.info?.(`freetoken: 上次退出遗留 ${scheduled} 个临时会话，已交给清理器补删`)
    }
    return scheduled
  }

  function stats(): CleanupStats {
    return {
      pending: queue.length,
      journalEntries: readJournal(file).length,
      lastFlushAt,
      deleted,
      failed,
    }
  }

  function dispose(): void {
    disposed = true
    clearTimer()
    // 内存队列丢弃；账本保留（state=queued），下次启动 sweep 补删
    queue = []
  }

  return {
    schedule,
    discard,
    flush,
    pendingCount: () => queue.length,
    stats,
    sweepStartup,
    dispose,
  }
}