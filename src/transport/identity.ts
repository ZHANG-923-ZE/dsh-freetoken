/**
 * 身份固化 + 单实例锁（R13 / D23–D24）。
 *
 * - `device.json`：deviceId、UA、client 版本持久化，跨重启复用（不清理）。
 * - `transport.lock`：传输层单实例；持有进程存活时第二实例拒绝启动。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { freetokenPath } from './paths.js'
import { FreetokenError } from '../adapter/errors.js'

export interface DeviceIdentity {
  version: 1
  deviceId: string
  userAgent: string | null
  clientVersion: string | null
  createdAt: number
}

export interface TransportLock {
  pid: number
  backend: string
  startedAt: number
}

function readJson<T>(file: string): T | undefined {
  try {
    if (!existsSync(file)) return undefined
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temp, file)
}

export function devicePath(env: NodeJS.ProcessEnv = process.env): string {
  return freetokenPath('device.json', env)
}

export function lockPath(env: NodeJS.ProcessEnv = process.env): string {
  return freetokenPath('transport.lock', env)
}

function sanitizeDevice(raw: unknown): DeviceIdentity | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const deviceId = typeof record.deviceId === 'string' ? record.deviceId.trim() : ''
  if (!deviceId) return undefined
  return {
    version: 1,
    deviceId,
    userAgent: typeof record.userAgent === 'string' ? record.userAgent : null,
    clientVersion: typeof record.clientVersion === 'string' ? record.clientVersion : null,
    createdAt:
      typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
        ? record.createdAt
        : Date.now(),
  }
}

export function readDevice(env: NodeJS.ProcessEnv = process.env): DeviceIdentity | undefined {
  return sanitizeDevice(readJson<unknown>(devicePath(env)))
}

/** 读取或创建设备身份（enabled 之后才调用）。 */
export function ensureDevice(
  env: NodeJS.ProcessEnv = process.env,
  patch: { userAgent?: string; clientVersion?: string } = {},
): DeviceIdentity {
  const existing = readDevice(env)
  if (existing) return existing
  const device: DeviceIdentity = {
    version: 1,
    deviceId: randomUUID(),
    userAgent: patch.userAgent ?? null,
    clientVersion: patch.clientVersion ?? null,
    createdAt: Date.now(),
  }
  writeJsonAtomic(devicePath(env), device)
  return device
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as { code?: string })?.code
    return code === 'EPERM'
  }
}

/** 读取当前锁（供 status 展示）。 */
export function readTransportLock(env: NodeJS.ProcessEnv = process.env): TransportLock | undefined {
  const raw = readJson<unknown>(lockPath(env))
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.pid !== 'number' || typeof record.startedAt !== 'number') return undefined
  return {
    pid: record.pid,
    backend: typeof record.backend === 'string' ? record.backend : 'cdp',
    startedAt: record.startedAt,
  }
}

/**
 * 获取单实例锁；已被存活进程持有时抛 `TRANSPORT_IN_USE`。
 * @returns 释放函数（只删除自己持有的锁）。
 */
export function acquireTransportLock(
  backend: string,
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  const file = lockPath(env)
  const current = readTransportLock(env)
  if (current && pidAlive(current.pid)) {
    throw new FreetokenError(
      'TRANSPORT_IN_USE',
      `freetoken: another transport instance is running (pid=${current.pid}); one account = one instance`,
    )
  }
  const own: TransportLock = { pid: process.pid, backend, startedAt: Date.now() }
  writeJsonAtomic(file, own)
  return () => {
    const held = readTransportLock(env)
    if (held && held.pid === process.pid) {
      try {
        unlinkSync(file)
      } catch {
        // 释放失败不抛：进程退出后由下次接管清理
      }
    }
  }
}
