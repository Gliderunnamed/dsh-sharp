/**
 * dsh-sharp / session.js
 *
 * 会话身份：把状态挂到一个稳定的 key 上。
 *
 * agent 是 cordis Scope 上的一个对象，它的 id 在不同版本里可能是 agent.id、
 * agent.session.id 或 agent.session.sessionId，所以这里做多路探测，任何一路
 * 拿到非空字符串就当作身份；全拿不到就返回 undefined（此时走全局默认值，
 * 不会串台）。
 */

/**
 * @param {unknown} agent
 * @returns {string | undefined}
 */
export function sessionKey(agent) {
  if (agent === null || agent === undefined) return undefined
  if (typeof agent !== 'object') return undefined

  const id = agent.id
  if (typeof id === 'string' && id.length > 0) return id

  const session = agent.session
  if (session !== null && typeof session === 'object') {
    const a = session.id
    if (typeof a === 'string' && a.length > 0) return a
    const b = session.sessionId
    if (typeof b === 'string' && b.length > 0) return b
    const c = session.key
    if (typeof c === 'string' && c.length > 0) return c
  }

  const key = agent.sessionId
  if (typeof key === 'string' && key.length > 0) return key

  return undefined
}
