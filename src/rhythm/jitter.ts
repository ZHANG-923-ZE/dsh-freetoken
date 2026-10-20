/**
 * 发送前随机抖动（R11 / M21）：对数正态、区间可配、非固定周期。
 * random 可注入；结果夹在 [minMs, maxMs] 内，保证“至少 2 秒”的硬下限。
 */

import type { Range } from '../config.js'

export interface JitterInput {
  range: Range
  /** 对数正态的 σ（越大越不均匀）；默认 0.35。 */
  sigma?: number
  /** 0..1 随机源（测试注入）。 */
  random?: () => number
}

/** Box–Muller：用两个均匀随机数得到标准正态样本。 */
function standardNormal(random: () => number): number {
  const u1 = Math.max(Number.MIN_VALUE, random())
  const u2 = Math.max(Number.MIN_VALUE, random())
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/**
 * 计算一次抖动毫秒数。
 * 中位数 = √(min·max)；夹取保证不越界（下限即“≥2s”约束）。
 */
export function nextJitter(input: JitterInput): number {
  const min = Math.max(0, Math.round(input.range.min))
  const max = Math.max(min, Math.round(input.range.max))
  if (max === min) return min
  const sigma = Math.min(3, Math.max(0.05, input.sigma ?? 0.35))
  const median = Math.sqrt(min * max)
  const sample = median * Math.exp(sigma * standardNormal(input.random ?? Math.random))
  return Math.max(min, Math.min(max, Math.round(sample)))
}
