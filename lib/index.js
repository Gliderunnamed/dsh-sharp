/**
 * dsh-sharp
 *
 * 一个纯宿主侧的 DSH 插件，做三件事：
 *
 *   1) 输出锐化 —— 往系统提示里插一节「回答契约」，强制模型先给结论、
 *      不铺垫、不复述、不道歉、不展示草稿、给最短可用答案。
 *   2) 思考治理 —— 在 agent/request 瀑布上把 reasoningEffort 压到该模型
 *      支持的最低非 off 档，减少多余思考（只降不升，可关）。
 *   3) 输出预算 —— 在同一个瀑布上给 maxTokens 加一个硬上限。这是本插件
 *      唯一能机械强制「简短」的地方：DeepSeek adapter 的默认上限是 256000
 *      tokens，等于没有上限，光靠提示词是拦不住啰嗦的。
 *
 * 一个旋钮管三件事：档位（lite/balanced/hard）自带思考模式与输出预算的默认值，
 * 需要时可以分别用 /sharp think、/sharp budget 单独覆盖。
 *
 * 设计约束：本插件刻意不 import 任何外部包（含 schemastery），因为 link:
 * 方式安装的插件按真实路径解析依赖，D:\dsh_work 下没有 node_modules。
 * 因此没有 Config schema —— 配置在 normalizeConfig 里手工归一化，
 * 运行时用 /sharp 命令切换。
 */

import { installBudgetGovernor, normalizeBudgetMode } from './budget.js'
import { registerSharpCommand } from './command.js'
import { renderContract } from './contract.js'
import { createModelInfoCache } from './model-info.js'
import { sessionKey } from './session.js'
import { installThinkingGovernor } from './thinking.js'
import { LEVEL_DEFAULTS, SharpState, normalizeLevel, normalizeThinkMode } from './state.js'

export const name = 'sharp'

/** systemPrompt 是硬依赖；llm / commands 走 ctx.get 可选获取。 */
export const inject = ['systemPrompt']

export const SECTION_NAME = 'dsh-sharp:contract'
export const DEFAULT_ORDER = 119

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  level: 'balanced',
  language: 'zh',
  order: DEFAULT_ORDER,
  thinking: Object.freeze({ mode: 'auto', prefer: Object.freeze(['low', 'minimal']) }),
  budget: Object.freeze({ mode: 'auto', normal: 16384, tight: 4096, strict: 2048, floor: 512 }),
})

function normalizeLanguage(value) {
  if (typeof value !== 'string') return DEFAULT_CONFIG.language
  const v = value.trim().toLowerCase()
  if (v === 'en' || v.startsWith('en-') || v === 'english') return 'en'
  if (v === 'both' || v === 'all' || v === 'zh+en' || v === 'bi') return 'both'
  if (v === 'zh' || v.startsWith('zh-') || v === 'cn' || v === 'chinese') return 'zh'
  return DEFAULT_CONFIG.language
}

function normalizeOrder(value) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_ORDER
  return Math.min(10000, Math.max(-10000, Math.trunc(n)))
}

function normalizePrefer(value) {
  if (!Array.isArray(value)) return [...DEFAULT_CONFIG.thinking.prefer]
  const out = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim().length > 0) out.push(item.trim())
  }
  return out.length > 0 ? out : [...DEFAULT_CONFIG.thinking.prefer]
}

function normalizeCap(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.trunc(n)
}

/**
 * 把宿主传来的（可能残缺、可能类型不对的）配置归一化成完整配置。
 * @param {unknown} raw
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const thinkingRaw = source.thinking !== null && typeof source.thinking === 'object' ? source.thinking : {}
  const budgetRaw = source.budget !== null && typeof source.budget === 'object' ? source.budget : {}

  const level = normalizeLevel(source.level) ?? DEFAULT_CONFIG.level
  const thinkMode = normalizeThinkMode(thinkingRaw.mode) ?? DEFAULT_CONFIG.thinking.mode
  const budgetMode = normalizeBudgetMode(budgetRaw.mode) ?? DEFAULT_CONFIG.budget.mode

  return {
    enabled: source.enabled === undefined ? DEFAULT_CONFIG.enabled : source.enabled !== false,
    level,
    language: normalizeLanguage(source.language),
    order: normalizeOrder(source.order),
    thinking: {
      mode: thinkMode,
      prefer: normalizePrefer(thinkingRaw.prefer),
    },
    budget: {
      mode: budgetMode,
      normal: normalizeCap(budgetRaw.normal, DEFAULT_CONFIG.budget.normal),
      tight: normalizeCap(budgetRaw.tight, DEFAULT_CONFIG.budget.tight),
      strict: normalizeCap(budgetRaw.strict, DEFAULT_CONFIG.budget.strict),
      floor: normalizeCap(budgetRaw.floor, DEFAULT_CONFIG.budget.floor),
    },
  }
}

/**
 * @template T
 * @param {() => T} fn
 * @returns {T | undefined}
 */
function attempt(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} config
 */
export function apply(ctx, config = {}) {
  const resolved = normalizeConfig(config)
  const state = new SharpState(resolved)

  ctx.effect(() => () => state.dispose(), 'dsh-sharp: session state')

  const onAgentDisposed = (payload) => {
    const agent = payload !== null && typeof payload === 'object' ? (payload.agent ?? payload) : payload
    const key = sessionKey(agent)
    if (key !== undefined) state.forget(key)
  }
  ctx.on('agent/disposed', onAgentDisposed)

  const systemPrompt = attempt(() => ctx.get('systemPrompt')) ?? ctx.systemPrompt
  if (systemPrompt !== undefined && systemPrompt !== null && typeof systemPrompt.section === 'function') {
    try {
      systemPrompt.section({
        name: SECTION_NAME,
        order: resolved.order,
        text: (context) => {
          const key = sessionKey(context?.agent)
          if (!state.active(key)) return ''
          return renderContract(state.level(key), resolved.language)
        },
      })
    } catch (error) {
      // 同名 section 已注册（例如插件被装了两遍）不该让整个 fiber 起不来。
      ctx.logger?.warn?.(`dsh-sharp: 回答契约未注册：${error?.message ?? error}`)
    }
  } else {
    ctx.logger?.warn?.('dsh-sharp: systemPrompt 服务不可用，输出契约未注册。')
  }

  const llm = attempt(() => ctx.get('llm'))
  const modelInfo =
    llm !== undefined && llm !== null && typeof llm.resolveModelInfo === 'function'
      ? createModelInfoCache(llm)
      : undefined

  const thinking = installThinkingGovernor(ctx, resolved, state, modelInfo)
  const budget = installBudgetGovernor(ctx, resolved, state, modelInfo)
  ctx.effect(() => () => {
    thinking.dispose()
    budget.dispose()
    modelInfo?.dispose()
  }, 'dsh-sharp: governors')

  registerSharpCommand(ctx, state, resolved, { thinking, budget, modelInfo, llm })

  const thinkText = state.thinkMode(undefined)
  const budgetText = state.budgetMode(undefined)
  const capText =
    budgetText === 'inherit'
      ? '交给模型'
      : typeof budgetText === 'number'
        ? `${budgetText} tokens`
        : `${resolved.budget[budgetText]} tokens`

  ctx.logger?.info?.(
    `dsh-sharp: 已启用（档位 ${resolved.level}，思考 ${thinkText}，输出上限 ${capText}）。用 /sharp 调整。`,
  )
}

export { LEVEL_DEFAULTS, SharpState, renderContract }
