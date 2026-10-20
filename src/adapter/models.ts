/**
 * 模型目录：网页端「快速模式」的两档 thinking 预设。
 * 依据基座实测：网页端只暴露 default 一档，thinking 开关构成两个可选预设。
 */

import type { ResolvedModelInfo } from './base.js'

export const PROVIDER = 'deepseek-web'
export const PROVIDER_NAME = 'DeepSeek 网页'
export const CONTEXT_WINDOW = 1_048_576

export interface ModelSpec {
  id: string
  name: string
  description: string
  thinking: boolean
  defaultMaxTokens: number
}

export const MODEL_SPECS: readonly ModelSpec[] = Object.freeze([
  {
    id: 'deepseek-chat',
    name: 'DeepSeek 网页 · 快速模式（不思考）',
    description:
      '同一模型，thinking 关闭：直接作答、最快、最省免费额度。适合工具调用/改写/检索类任务。',
    thinking: false,
    defaultMaxTokens: 8192,
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek 网页 · 快速模式（深度思考）',
    description:
      '同一模型，thinking 开启：先推理再作答（推理流作为思考块回传）。适合数学/多步调试/规划。',
    thinking: true,
    defaultMaxTokens: 8192,
  },
])

const ALIASES: Readonly<Record<string, string>> = {
  'deepseek-pro': 'deepseek-chat',
  'deepseek-expert': 'deepseek-chat',
  'deepseek-vision': 'deepseek-chat',
}

/** 解析模型 id：未知/历史别名回退到快速模式（不报错，保持旧会话可用）。 */
export function resolveSpec(modelId: string): ModelSpec {
  const id = ALIASES[modelId] ?? modelId
  return MODEL_SPECS.find((spec) => spec.id === id) ?? MODEL_SPECS[0]!
}

export function modelInfoFor(provider: string, spec: ModelSpec): ResolvedModelInfo {
  return {
    provider,
    id: spec.id,
    name: spec.name,
    description: spec.description,
    inputModalities: ['text', 'image'],
    context: { contextWindow: CONTEXT_WINDOW },
    defaultMaxTokens: spec.defaultMaxTokens,
    systemPromptUpdate: 'in-history',
    toolUpdate: 'in-history',
  }
}
