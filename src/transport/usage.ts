/**
 * 跨重启的今日请求计数（保守模式 / D33）。
 *
 * 封禁事件复盘里最关键的缺陷之一：todayRequests 只在内存，重启即清零，
 * 导致动态静默与日预算永远达不到阈值。这里把 (本地日期, 已发次数) 落盘，
 * 启动时恢复；跨自然日自动忽略旧值。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { freetokenPath } from './paths.js'

export interface UsageState {
  day: string
  count: number
}

export function usagePath(env: NodeJS.ProcessEnv = process.env): string {
  return freetokenPath('usage.json', env)
}

export function localDayKey(now: number = Date.now()): string {
  const date = new Date(now)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function readUsage(env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): UsageState | undefined {
  try {
    const file = usagePath(env)
    if (!existsSync(file)) return undefined
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const day = typeof raw?.day === 'string' ? raw.day : ''
    const count = Number(raw?.count)
    if (!day || !Number.isFinite(count) || count < 0) return undefined
    // 跨日：旧计数不再计入今天
    if (day !== localDayKey(now)) return { day: localDayKey(now), count: 0 }
    return { day, count: Math.floor(count) }
  } catch {
    return undefined
  }
}

export function writeUsage(count: number, env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): void {
  try {
    const file = usagePath(env)
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temp, `${JSON.stringify({ day: localDayKey(now), count: Math.max(0, Math.floor(count)), at: now }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temp, file)
  } catch {
    // 落盘失败不阻塞请求；下次启动最多少恢复一次计数
  }
}