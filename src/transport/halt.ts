/**
 * 止损熔断的落盘状态（D26 / R16）。
 *
 * 账号被 mute/封禁后必须**跨重启**保持停止发送，直到解除时间或人工恢复；
 * 只在内存里记 halted 的话，重启一次就会继续打请求 —— 2026-10-20 真机踩过
 * （账号被禁到 2026-10-23，重启后仍会尝试发送）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { freetokenPath } from './paths.js'

export interface HaltState {
  halted: boolean
  reason: string
  /** 解除时间（epoch ms）；null = 未知，需人工恢复。 */
  mutedUntil: number | null
  at: number
}

export function haltPath(env: NodeJS.ProcessEnv = process.env): string {
  return freetokenPath('halt.json', env)
}

export function readHalt(env: NodeJS.ProcessEnv = process.env): HaltState | undefined {
  try {
    const file = haltPath(env)
    if (!existsSync(file)) return undefined
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object') return undefined
    const mutedUntil = typeof raw.mutedUntil === 'number' && Number.isFinite(raw.mutedUntil) ? raw.mutedUntil : null
    return {
      halted: raw.halted === true,
      reason: String(raw.reason ?? 'halted'),
      mutedUntil,
      at: Number.isFinite(raw.at) ? Number(raw.at) : Date.now(),
    }
  } catch {
    return undefined
  }
}

export function writeHalt(state: HaltState, env: NodeJS.ProcessEnv = process.env): void {
  const file = haltPath(env)
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temp, `${JSON.stringify({ ...state, at: state.at || Date.now() }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, file)
  } catch {
    // 落盘失败不阻塞；内存熔断仍然生效
  }
}

export function clearHalt(env: NodeJS.ProcessEnv = process.env): void {
  try {
    unlinkSync(haltPath(env))
  } catch {
    // 文件不存在忽略
  }
}

/**
 * 当前是否必须拒绝发送。
 * - halted 且解除时间未知 → 一直拒绝；
 * - halted 且有解除时间 → 到期前拒绝，到期后自动放行（仍保留记录供 status 展示）。
 */
export function haltBlocksSend(state: HaltState | undefined, now: number = Date.now()): boolean {
  if (!state?.halted) return false
  if (state.mutedUntil === null) return true
  return now < state.mutedUntil
}