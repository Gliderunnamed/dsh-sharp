/**
 * dsh-sharp / command.js
 *
 * `/sharp` 命令：在聊天里直接切档位，不用改配置、不用重启。
 *
 *   /sharp                    看状态
 *   /sharp on | off           插件总开关
 *   /sharp lite|normal|hard   档位（同时决定思考模式与输出预算的默认值）
 *   /sharp think <模式>       单独覆盖思考模式
 *   /sharp budget <模式|N>    单独覆盖输出上限
 *   /sharp why                说明当前实际生效的是什么（含该模型真实支持的档位）
 *   /sharp reset              清掉本会话的覆盖
 *   /sharp contract           把当前契约原文打出来（确认到底注入了什么）
 *   /sharp help
 */

import { BUDGET_MODES, normalizeBudgetMode } from './budget.js'
import { renderContract } from './contract.js'
import { sessionKey } from './session.js'
import { LEVELS, THINK_MODES, normalizeLevel, normalizeThinkMode } from './state.js'
import { listEfforts, pickLowerEffort } from './thinking.js'

const HELP = [
  '/sharp —— 锐化输出（作用于当前会话）',
  '  /sharp                 看当前状态',
  '  /sharp on | off        插件总开关',
  '  /sharp lite            只删废话（不动思考预算、不压输出上限）',
  '  /sharp normal          balanced 默认档（思考压到最低非 off 档）',
  '  /sharp hard            最短最硬（思考最低 + 输出上限收紧）',
  '  /sharp think <模式>    auto | inherit | low | default',
  '  /sharp budget <模式>   auto | off | normal | tight | strict | 具体 token 数',
  '  /sharp why             说明当前实际生效的档位/思考/上限，以及模型支持哪些档',
  '  /sharp reset           清掉本会话覆盖，回到全局默认',
  '  /sharp contract        打印当前注入的契约原文',
  '  /sharp help            这条帮助',
].join('\n')

const CAP_NOTE = {
  normal: '宽松兜底',
  tight: '收紧',
  strict: '很紧',
}

function ok(text) {
  return { kind: 'success', text }
}

function bad(text) {
  return { kind: 'error', text }
}

/** 把生效的思考模式翻译成人话。 */
function thinkLabel(info) {
  const suffix = info.thinkAuto ? '（随档位自动）' : ''
  if (info.think === 'inherit') return `不动模型的思考配置${suffix}`
  if (info.think === 'model-default') return `交回模型默认${suffix}`
  return `压到该模型最低的非 off 档${suffix}`
}

/** 把生效的输出预算翻译成人话。 */
function budgetLabel(info, config) {
  const raw = info.budgetRaw
  const suffix = info.budgetAuto ? '（随档位自动）' : ''
  if (raw === 'auto' && info.budget === 'inherit') return `不限，交给模型/连接默认${suffix}`
  if (typeof info.budget === 'number') return `${info.budget} tokens${info.budgetAuto ? '' : '（本会话指定）'}`
  if (info.budget === 'inherit') return `不限，交给模型/连接默认${suffix}`
  const cap = config.budget[info.budget]
  return `${info.budget} = ${cap} tokens（${CAP_NOTE[info.budget] ?? ''}）${suffix}`
}

/** 读出当前 agent 的路由（provider/model）。拿不到就返回 undefined。 */
function readRoute(agent) {
  try {
    const config = agent?.session?.requestHeader?.()?.config
    if (config !== null && typeof config === 'object') {
      if (typeof config.provider === 'string' && typeof config.model === 'string') return config
    }
  } catch {
    /* 宿主没暴露 header 就退化成只说配置 */
  }
  return undefined
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./state.js').SharpState} state
 * @param {{ enabled: boolean, level: string, language: string, order: number, thinking: { mode: string, prefer: string[] }, budget: { mode: string | number, normal: number, tight: number, strict: number, floor: number } }} config
 * @param {{ thinking: { active: boolean }, budget: { active: boolean }, modelInfo?: { get: Function }, llm?: unknown }} governors
 */
export function registerSharpCommand(ctx, state, config, governors) {
  let commands = undefined
  try {
    commands = ctx.get('commands')
  } catch {
    commands = undefined
  }
  if (commands === undefined || commands === null || typeof commands.register !== 'function') return false

  const notify = () => {
    try {
      ctx.emit('system-prompt/change')
    } catch {
      /* 提示词变了但没人监听也无所谓 */
    }
  }

  const statusText = (key) => {
    const info = state.describe(key)
    const lines = [
      `dsh-sharp：${info.enabled ? '已启用' : '已停用'}`,
      `  档位   ${info.level}`,
      `  思考   ${thinkLabel(info)}`,
      `  上限   ${budgetLabel(info, config)}`,
      `  语言   ${info.language}`,
      `  会话覆盖 ${info.overridden ? '有' : '无'}`,
    ]
    if (!governors.thinking.active && !governors.budget.active) lines.push('  （llm 服务不可用，只注入契约）')
    return lines.join('\n')
  }

  commands.register({
    name: 'sharp',
    description: '锐化 AI 输出：回答直白简短、少绕弯子、少废话思考',
    input: { hint: '[on|off|lite|normal|hard|think|budget|why|reset|contract|help]' },
    handler: async (invocation) => {
      const key = sessionKey(invocation?.agent)
      const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
      const parts = raw.length === 0 ? [] : raw.split(/\s+/)
      const head = (parts[0] ?? '').toLowerCase()

      if (head === '' || head === 'status') return ok(statusText(key))

      if (head === 'help' || head === '?') return ok(HELP)

      if (head === 'on') {
        const fallback = config.level === 'off' ? 'balanced' : config.level
        if (!state.setLevel(key, fallback)) return bad('拿不到会话标识，无法切换。')
        notify()
        return ok(`已启用（档位 ${fallback}）。` + '\n' + statusText(key))
      }

      if (head === 'off') {
        if (!state.setLevel(key, 'off')) return bad('拿不到会话标识，无法切换。')
        notify()
        return ok('已停用（本会话不再注入契约，也不再改思考/输出上限）。')
      }

      if (head === 'reset' || head === 'clear') {
        const had = state.reset(key)
        notify()
        return ok(had ? '已清掉本会话覆盖。' + '\n' + statusText(key) : '本会话本来就没有覆盖。' + '\n' + statusText(key))
      }

      if (head === 'contract' || head === 'show') {
        if (!state.active(key)) return ok('当前未注入契约（已停用或档位为 off）。')
        const text = renderContract(state.level(key), config.language)
        return ok(text.length === 0 ? '当前未注入契约。' : text)
      }

      if (head === 'think') {
        const arg = parts[1] ?? ''
        const mode = normalizeThinkMode(arg)
        if (mode === undefined) {
          if (arg !== '') return bad(`不认识的思考模式「${arg}」。用 /sharp think 看可选项。`)
          const info = state.describe(key)
          return ok(
            [
              `当前思考：${thinkLabel(info)}`,
              `可选：${THINK_MODES.join(' | ')}`,
              '  auto           跟着档位走（lite 不动 / balanced、hard 压到最低非 off 档）',
              '  inherit        任何档位都不动模型的思考配置',
              '  low            压到模型支持的最低思考档',
              '  default        交回模型默认（删掉显式 effort）',
            ].join('\n'),
          )
        }
        if (!state.setThinkMode(key, mode)) return bad('拿不到会话标识，无法切换。')
        notify()
        return ok(`思考模式已设为 ${mode}。` + '\n' + statusText(key))
      }

      if (head === 'budget' || head === 'cap' || head === 'limit') {
        const mode = normalizeBudgetMode(parts[1] ?? '')
        if (parts[1] === undefined) {
          return ok(
            [
              `当前上限：${budgetLabel(state.describe(key), config)}`,
              `可选：${BUDGET_MODES.join(' | ')} | 具体 token 数`,
              `  auto     跟着档位走（lite/balanced 不限 / hard 收紧到 ${config.budget.tight}）`,
              `  off      不设上限，交给模型/连接默认`,
              `  normal   ${config.budget.normal} tokens`,
              `  tight    ${config.budget.tight} tokens`,
              `  strict   ${config.budget.strict} tokens`,
              `  512..N   直接给一个 token 数（地板 ${config.budget.floor}）`,
            ].join('\n'),
          )
        }
        if (mode === undefined) return bad(`不认识的预算「${parts[1]}」。用 /sharp budget 看可选项。`)
        if (!state.setBudgetMode(key, mode)) return bad('拿不到会话标识，无法切换。')
        notify()
        return ok(`输出上限已设为 ${typeof mode === 'number' ? `${mode} tokens` : mode}。` + '\n' + statusText(key))
      }

      if (head === 'why') {
        const info = state.describe(key)
        const lines = [
          `档位：${info.level}`,
          `思考：${thinkLabel(info)}`,
          `上限：${budgetLabel(info, config)}`,
        ]
        const route = readRoute(invocation?.agent)
        if (route === undefined) {
          lines.push('路由：拿不到当前 provider/model，无法核对该模型真正支持什么。')
          return ok(lines.join('\n'))
        }
        lines.push(`路由：${route.provider} / ${route.model}`)
        if (governors.modelInfo === undefined) {
          lines.push('llm 服务不可用，无法解析该模型的思考档位。')
          return ok(lines.join('\n'))
        }
        let model
        try {
          model = await governors.modelInfo.get(route.provider, route.model, invocation?.signal)
        } catch {
          model = null
        }
        const efforts = listEfforts(model)
        if (efforts.length === 0) {
          lines.push('该模型没有声明 reasoning 档位（不支持的模型会被本插件跳过，不改配置）。')
          return ok(lines.join('\n'))
        }
        lines.push(`该模型支持：${efforts.join(' | ')}`)
        if (model?.defaultMaxTokens !== undefined) lines.push(`该模型默认输出上限：${model.defaultMaxTokens}`)
        const target = pickLowerEffort(model, config.thinking.prefer)
        if (info.think === 'inherit') lines.push('当前是 inherit：本插件不会改 reasoningEffort。')
        else if (info.think === 'model-default') lines.push('当前是 default：本插件会删掉显式 effort，交回模型默认。')
        else if (target === undefined) lines.push('算不出目标档位：不改 reasoningEffort。')
        else lines.push(`prefer-low 目标：${target}`)
        return ok(lines.join('\n'))
      }

      const level = normalizeLevel(head)
      if (level !== undefined) {
        if (!state.setLevel(key, level)) return bad('拿不到会话标识，无法切换。')
        notify()
        return ok(
          (level === 'off' ? '已停用（本会话不再注入契约）。' : `档位已设为 ${level}。`) + '\n' + statusText(key),
        )
      }

      return bad(`不认识的参数「${parts[0]}」。\n\n${HELP}`)
    },
  })

  return true
}

export { LEVELS, THINK_MODES }
