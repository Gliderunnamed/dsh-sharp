/**
 * dsh-sharp / budget.js
 *
 * 「输出预算」治理 —— 本插件唯一能**机械强制**简短的地方。
 *
 * 契约（注入提示词）只是请求模型写短一点；而 `maxTokens` 是随请求一起发给
 * provider 的硬上限。DeepSeek adapter 的默认值是 DEFAULT_MAX_TOKENS = 256000
 * （`max_tokens: options.maxTokens ?? model.maxTokens ?? connection.maxTokens`），
 * 对聊天来说等于没有上限 —— 模型想啰嗦多久就啰嗦多久。压一个显式上限，
 * 才是真正把「直白简短」变成不可绕过的约束。
 *
 * 安全约束（和思考治理器同一套哲学）：
 *   1. 只降不升 —— 宿主/用户已经设了更低的上限就不动。
 *   2. 有地板 —— 绝不压到 floor 以下，避免把答案从中间截断（截断比啰嗦更糟）。
 *   3. 任何异常都原样放行，绝不因为本插件让请求失败。
 */

import { sessionKey } from './session.js'

/** 输出预算模式。auto = 跟着锐化档位走。 */
export const BUDGET_MODES = ['auto', 'inherit', 'normal', 'tight', 'strict']

/**
 * 归一化输出预算模式。接受模式名，也接受一个显式 token 数。
 *
 * @param {unknown} value
 * @returns {'auto' | 'inherit' | 'normal' | 'tight' | 'strict' | number | undefined}
 */
export function normalizeBudgetMode(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
  }
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase()
  if (v === '') return undefined
  if (/^[0-9]+$/.test(v)) {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  if (v === 'auto' || v === 'level' || v === 'by-level') return 'auto'
  if (v === 'inherit' || v === 'off' || v === 'none' || v === 'keep' || v === 'unlimited') return 'inherit'
  if (v === 'normal' || v === 'loose') return 'normal'
  if (v === 'tight' || v === 'short') return 'tight'
  if (v === 'strict' || v === 'min' || v === 'minimum' || v === 'tiny') return 'strict'
  return undefined
}

/**
 * 算出要写进调用配置的 maxTokens。返回 undefined 表示「不改」。
 *
 * @param {{ current?: unknown, modelDefault?: unknown, cap: number, floor?: number }} input
 * @returns {number | undefined}
 */
export function pickBudgetCap(input) {
  const cap = input?.cap
  if (!Number.isFinite(cap) || cap <= 0) return undefined

  const floor = Number.isFinite(input?.floor) && input.floor > 0 ? Math.trunc(input.floor) : 1
  const limit = Math.max(Math.trunc(cap), floor)

  // 只降不升：已知的现值/模型默认值只要不高于 limit，就完全不动。
  for (const value of [input?.current, input?.modelDefault]) {
    if (Number.isFinite(value) && value > 0 && Math.trunc(value) <= limit) return undefined
  }
  return limit
}

/**
 * 安装输出预算治理器。返回 { active, dispose }。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ budget: { mode: string | number, normal: number, tight: number, strict: number, floor: number } }} config
 * @param {import('./state.js').SharpState} state
 * @param {{ get: (provider: string, model: string, signal?: AbortSignal) => Promise<any> } | undefined} modelInfo
 */
export function installBudgetGovernor(ctx, config, state, modelInfo) {
  const noop = { active: false, dispose() {} }
  if (modelInfo === undefined || modelInfo === null) return noop

  let disposed = false

  const listener = async (payload, next) => {
    const base = await next()
    try {
      if (disposed) return base
      if (base === null || typeof base !== 'object') return base

      const key = sessionKey(payload?.agent)
      if (!state.active(key)) return base

      const mode = state.budgetMode(key)
      if (mode === 'inherit') return base

      const cap = typeof mode === 'number' ? mode : config.budget[mode]
      if (!Number.isFinite(cap) || cap <= 0) return base

      const provider = base.provider
      const model = base.model
      let modelDefault
      if (typeof provider === 'string' && typeof model === 'string') {
        const info = await modelInfo.get(provider, model, payload?.signal)
        const declared = info?.defaultMaxTokens
        if (Number.isFinite(declared) && declared > 0) modelDefault = declared
      }

      const chosen = pickBudgetCap({
        current: base.maxTokens,
        modelDefault,
        cap,
        floor: config.budget.floor,
      })
      if (chosen === undefined || base.maxTokens === chosen) return base
      return { ...base, maxTokens: chosen }
    } catch {
      return base
    }
  }

  ctx.on('agent/request', listener)

  return {
    active: true,
    dispose() {
      disposed = true
    },
  }
}
