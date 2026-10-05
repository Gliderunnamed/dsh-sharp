/**
 * dsh-sharp / thinking.js
 *
 * 「多余思考」治理。
 *
 * 挂在 agent/request 瀑布上：先让宿主算出它本来要用的调用配置（next()），
 * 再按模式改写 reasoningEffort。
 *
 *   prefer-low      —— 把思考预算压到该模型支持的最低档（默认找 low/minimal）
 *   model-default   —— 删掉显式 effort，交回模型/adapter 的默认值
 *   inherit         —— 完全不动
 *
 * 关键安全约束：**只降不升**。如果宿主/用户已经指定了一个比目标更低（或相等）
 * 的档位，我们原样放行，绝不把思考量抬上去。任何异常都 return base，绝不因为
 * 本插件让一次请求失败。
 *
 * 注意：监听器一旦装上就**一直挂着**，模式判断放在每个请求里（一次 Map 查询）。
 * 因为分析模式可以是 'auto'（随档位变），会话也可能运行时用 /sharp think 改，
 * 装的时候提前退掉会让运行时的切换失灵。
 */

import { sessionKey } from './session.js'

const RANK = new Map([
  ['none', 0],
  ['off', 0],
  ['disabled', 0],
  ['no', 0],
  ['minimal', 1],
  ['min', 1],
  ['tiny', 1],
  ['low', 2],
  ['light', 2],
  ['medium', 3],
  ['mid', 3],
  ['normal', 3],
  ['default', 3],
  ['standard', 3],
  ['high', 4],
  ['deep', 4],
  ['max', 5],
  ['maximum', 5],
  ['ultra', 6],
  ['extreme', 6],
])

const UNKNOWN_RANK = 3

/**
 * 未知的 effort 名字给 3（中档），这样它既不会被当成最低档而被忽略，
 * 也不会被当成最高档而挡住降级。
 * @param {unknown} id
 * @returns {number | undefined}
 */
export function rankOf(id) {
  if (typeof id !== 'string') return undefined
  const key = id.trim().toLowerCase()
  if (key === '') return undefined
  const rank = RANK.get(key)
  return rank === undefined ? UNKNOWN_RANK : rank
}

/** 从 efforts 列表里挑出 id（兼容字符串项和 {id} 对象项）。 */
export function listEfforts(info) {
  const efforts = info?.reasoning?.efforts
  if (!Array.isArray(efforts)) return []
  const ids = []
  for (const effort of efforts) {
    const id = typeof effort === 'string' ? effort : effort?.id
    if (typeof id === 'string' && id.length > 0) ids.push(id)
  }
  return ids
}

/**
 * 在该模型支持的努力档位里挑「最低」的那个：先按 prefer 列表找精确名字，
 * 找不到再按语义排名取最小 —— 但**不低于 prefer 白名单的地板**。
 *
 * 地板的理由（对着真实 adapter 定的）：DeepSeek 的档位是 off/low/high/max，
 * 默认是 high。如果只按「排名最小」兜底，一旦白名单全没命中就会挑到 off，
 * 等于把思考彻底关掉 —— 那是质量事故，不是「少想一点」。所以白名单同时
 * 表达意图下限：永远不选比白名单里最温和那项还低的档位。
 *
 * @param {unknown} info LlmResolvedModelInfo
 * @param {readonly string[]} prefer
 * @returns {string | undefined}
 */
export function pickLowerEffort(info, prefer) {
  const ids = listEfforts(info)
  if (ids.length === 0) return undefined

  const list = (Array.isArray(prefer) ? prefer : []).filter((want) => typeof want === 'string' && want.trim() !== '')

  const byLower = new Map()
  for (const id of ids) {
    const key = id.toLowerCase()
    if (!byLower.has(key)) byLower.set(key, id)
  }
  for (const want of list) {
    const hit = byLower.get(want.trim().toLowerCase())
    if (hit !== undefined) return hit
  }

  // 白名单一个都没命中：退回到「语义最低但不得低于地板」的档位。
  let floor = Infinity
  for (const want of list) {
    const rank = rankOf(want)
    if (rank !== undefined && rank < floor) floor = rank
  }
  if (floor === Infinity) floor = 0

  let best
  let bestRank = Infinity
  for (const id of ids) {
    const rank = rankOf(id) ?? UNKNOWN_RANK
    if (rank < floor) continue
    if (rank < bestRank) {
      best = id
      bestRank = rank
    }
  }
  return best
}

/**
 * 安装思考治理器。返回 { active, dispose }。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ thinking: { mode: string, prefer: string[] } }} config
 * @param {import('./state.js').SharpState} state
 * @param {{ get: (provider: string, model: string, signal?: AbortSignal) => Promise<any> } | undefined} modelInfo
 */
export function installThinkingGovernor(ctx, config, state, modelInfo) {
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

      const mode = state.thinkMode(key)
      if (mode === 'inherit') return base

      if (mode === 'model-default') {
        if (base.reasoningEffort === undefined) return base
        const clone = { ...base }
        delete clone.reasoningEffort
        return clone
      }

      // mode === 'prefer-low'
      const provider = base.provider
      const model = base.model
      if (typeof provider !== 'string' || typeof model !== 'string') return base

      const info = await modelInfo.get(provider, model, payload?.signal)
      const target = pickLowerEffort(info, config.thinking.prefer)
      if (target === undefined) return base

      const current = base.reasoningEffort
      if (typeof current === 'string' && current.length > 0) {
        if (current.toLowerCase() === target.toLowerCase()) return base
        const currentRank = rankOf(current)
        const targetRank = rankOf(target)
        // 只降不升
        if (currentRank !== undefined && targetRank !== undefined && currentRank <= targetRank) return base
      }

      return { ...base, reasoningEffort: target }
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
