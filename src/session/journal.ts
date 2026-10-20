/**
 * 待删账本（P2.4 / M10）：`<DSH_HOME>/freetoken/sessions-in-use.json`。
 *
 * 只记「还欠一次删除」的网页会话：复用槽里的（state=slot）与已排队待删的
 * （state=queued）。删除被服务端确认后才摘账，因此进程退出/被强杀之后，
 * 下次启动还能按账本补删，网页端不会静默堆积临时会话。
 *
 * 约束：
 *  - 只存映射元数据（账号 id / 网页会话 id / pid / 时间 / 状态），绝不存凭证；
 *  - 写盘一律「同目录临时文件 + rename」原子替换，mode 0600；
 *  - 文件缺失 / 损坏 / 结构不对一律当空账本，绝不因此让插件启动失败。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { freetokenPath } from '../transport/paths.js'

export type JournalState = 'slot' | 'queued'

export interface JournalEntry {
  accountId: string
  sessionId: string
  pid: number
  at: number
  state: JournalState
}

/** upsert 入参：pid/at 缺省时由实现补齐（对齐基座行为）。 */
export type JournalEntryInput = Omit<JournalEntry, 'pid' | 'at'> & { pid?: number; at?: number }

interface JournalFile {
  version: 1
  entries: JournalEntry[]
}

const JOURNAL_FILE = 'sessions-in-use.json'
const FILE_MODE = 0o600

/** 账本路径（默认 `<DSH_HOME>/freetoken/sessions-in-use.json`）。 */
export function journalPath(env: NodeJS.ProcessEnv = process.env): string {
  return freetokenPath(JOURNAL_FILE, env)
}

/**
 * 单条记录规整：形状不对（缺 accountId/sessionId）→ 丢弃；数字字段非法 → 0。
 * 只保留白名单字段，任何多余的（例如凭证）一律不落盘。
 */
function normalizeEntry(raw: unknown): JournalEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Record<string, unknown>
  const accountId = typeof value.accountId === 'string' ? value.accountId.trim() : ''
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : ''
  if (!accountId || !sessionId) return undefined
  return {
    accountId,
    sessionId,
    pid: typeof value.pid === 'number' && Number.isFinite(value.pid) ? Math.floor(value.pid) : 0,
    at: typeof value.at === 'number' && Number.isFinite(value.at) ? Math.floor(value.at) : 0,
    state: value.state === 'queued' ? 'queued' : 'slot',
  }
}

function normalizeList(entries: unknown): JournalEntry[] {
  if (!Array.isArray(entries)) return []
  const bySession = new Map<string, JournalEntry>()
  for (const item of entries) {
    const entry = normalizeEntry(item)
    // 同一 sessionId 只保留最后一条（upsert 语义；损坏文件里可能有重复）
    if (entry) bySession.set(entry.sessionId, entry)
  }
  return [...bySession.values()]
}

/** 进程是否还活着（判断写账本的那个进程走了没有）。 */
export function isProcessAlive(pid: number): boolean {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/**
 * 读账本。文件不存在 / 损坏 / 结构不对一律返回空数组；单条坏记录被丢掉，
 * 其余照常可用（绝不因此让插件启动失败）。
 */
export function readJournal(file: string = journalPath()): JournalEntry[] {
  try {
    if (!existsSync(file)) return []
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const raw = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as JournalFile).entries)
        ? (parsed as JournalFile).entries
        : []
    return normalizeList(raw)
  } catch {
    return []
  }
}

/**
 * 原子写账本：先写同目录临时文件，再 rename 替换，避免中途被杀留下半截 JSON。
 * 落盘失败只吞掉（最多少一次补删），绝不阻塞请求主流程。
 */
export function writeJournal(entries: JournalEntry[], file: string = journalPath()): void {
  const payload = `${JSON.stringify({ version: 1, entries: normalizeList(entries) }, null, 2)}\n`
  try {
    mkdirSync(dirname(file), { recursive: true })
  } catch {
    // 目录建不了也继续尝试写；真正的失败由下面的写入分支兜底
  }
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temp, payload, { encoding: 'utf8', mode: FILE_MODE })
    try {
      renameSync(temp, file)
    } catch {
      // 少数文件系统上 rename 不能覆盖：退化为直接写（仍是完整 JSON）
      writeFileSync(file, payload, { encoding: 'utf8', mode: FILE_MODE })
      try {
        unlinkSync(temp)
      } catch {
        /* ignore */
      }
    }
  } catch {
    try {
      unlinkSync(temp)
    } catch {
      /* ignore */
    }
  }
}

/** 记一条（同一 sessionId 覆盖），用于 `leased`（slot）与 `queued` 两种欠账。 */
export function upsertJournalEntry(entry: JournalEntryInput, file: string = journalPath()): void {
  const normalized = normalizeEntry({
    ...entry,
    pid: entry.pid ?? process.pid,
    at: entry.at ?? Date.now(),
  })
  if (!normalized) return
  const entries = readJournal(file).filter((item) => item.sessionId !== normalized.sessionId)
  entries.push(normalized)
  writeJournal(entries, file)
}

/** 确认删掉（或决定不删）→ 摘掉这条。 */
export function removeJournalEntry(sessionId: string, file: string = journalPath()): void {
  if (typeof sessionId !== 'string' || !sessionId) return
  const entries = readJournal(file)
  const kept = entries.filter((item) => item.sessionId !== sessionId)
  if (kept.length === entries.length) return
  writeJournal(kept, file)
}

export interface StartupSweepOptions {
  ownPid: number
  isAlive?: (pid: number) => boolean
  deleteEnabled: boolean
  mode: 'deferred' | 'keep'
  accountExists?: (id: string) => boolean
}

export interface StartupSweepPlan {
  toDelete: JournalEntry[]
  kept: JournalEntry[]
  dropped: JournalEntry[]
}

/**
 * 纯决策：每一条记录该怎么办。不碰磁盘、不发请求，可离线测。
 *
 * 判定顺序有意如此：
 *  1) 进程还活着 → 保留（多实例共用同一个 DSH_HOME 时，别删另一个实例正在用的会话）；
 *  2) 用户不允许删（keep / deleteEnabled=false）→ 保留，等以后允许了再扫；
 *  3) 账号已被移除 → 放弃（没凭证，留着也删不掉）；
 *  4) 其余 → 补删。
 */
export function planStartupSweep(entries: JournalEntry[], options: StartupSweepOptions): StartupSweepPlan {
  const plan: StartupSweepPlan = { toDelete: [], kept: [], dropped: [] }
  if (!Array.isArray(entries)) return plan
  const isAlive = options.isAlive ?? isProcessAlive
  const accountExists = options.accountExists
  for (const entry of entries) {
    if (!entry || typeof entry.sessionId !== 'string' || !entry.sessionId) continue
    if (entry.pid === options.ownPid || isAlive(entry.pid)) {
      plan.kept.push(entry)
      continue
    }
    if (!options.deleteEnabled || options.mode === 'keep') {
      plan.kept.push(entry)
      continue
    }
    if (accountExists && !accountExists(entry.accountId)) {
      plan.dropped.push(entry)
      continue
    }
    plan.toDelete.push(entry)
  }
  return plan
}