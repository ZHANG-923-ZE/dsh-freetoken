/**
 * 动态静默时长（R16 / D14）。
 *
 * 基础静默 = [silenceMs.min, silenceMs.max] 内随机；再按今日累计请求数上调
 * （每 perRequests 次加 stepMs，封顶 capMs）。纯函数，random 可注入。
 */

import type { FreetokenConfig } from '../config.js'

export interface SilenceInput {
  config: FreetokenConfig
  todayRequests: number
  random?: () => number
}

export function silenceDuration(input: SilenceInput): number {
  const { config, todayRequests } = input
  const range = config.rhythm.silenceMs
  const min = Math.max(0, Math.round(range.min))
  const max = Math.max(min, Math.round(range.max))
  const random = input.random ?? Math.random
  const base = max === min ? min : min + Math.round((max - min) * random())
  const scale = config.rhythm.silenceScale
  const steps = Math.max(0, Math.floor(Math.max(0, todayRequests) / Math.max(1, scale.perRequests)))
  const extra = Math.min(Math.max(0, scale.capMs), steps * Math.max(0, scale.stepMs))
  return base + extra
}
