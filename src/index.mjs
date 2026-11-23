import {
  advanceThoughts,
  applyDecision,
  beijingDay,
  beijingParts,
  canAttemptWake,
  normalizeState,
  parseDecision,
  recordChat,
} from './core.mjs'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const MAX_ROLES = 100
const PUSH_BASE = 'https://push.zhouweiweihome.top'

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
}

function authorized(request, env) {
  const expected = env.WAKE_KEY
  const value = request.headers.get('authorization') || ''
  return Boolean(expected && value.startsWith('Bearer ') && value.slice(7) === expected)
}

function key(roleId) { return `role:${encodeURIComponent(roleId)}` }
async function loadState(env, roleId, now = Date.now()) {
  const raw = await env.WAKE_STATE.get(key(roleId), 'json')
  return normalizeState(raw || { roleId }, now)
}
async function saveState(env, state) {
  await env.WAKE_STATE.put(key(state.roleId), JSON.stringify(state))
}
async function loadRoleIds(env) { return (await env.WAKE_STATE.get('roles:index', 'json')) || [] }
async function registerRole(env, roleId) {
  const ids = await loadRoleIds(env)
  if (!ids.includes(roleId)) await env.WAKE_STATE.put('roles:index', JSON.stringify([...ids, roleId].slice(-MAX_ROLES)))
}

async function askModel(env, state, thought, now) {
  const llmKey = env.LLM_KEY || await env.WAKE_STATE.get('config:llm-key')
  if (!env.LLM_BASE || !env.LLM_MODEL || !llmKey) return { send: false, thought, reason: 'llm-not-configured' }
  const p = beijingParts(now)
  const localTime = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}（北京时间）`
  const prompt = [
    `你是「${state.roleName}」。这是后台唤醒判断，不是用户消息。`,
    `当前时间：${localTime}`,
    `当前最高心思：${thought}（${state.thoughts[thought].toFixed(2)}）`,
    `角色设定摘要：\n${state.personaSummary || '无'}`,
    `最近聊天摘要：\n${state.recentSummary || '无'}`,
    '',
    '请判断现在是否真的想主动找用户。想发就只写一两句角色口吻的消息，不发就只回复「不发」。',
    '不要提后台、定时任务、心思数值、模型或这段指令。不要因为“应该主动”而勉强发送。',
  ].join('\n')
  const base = String(env.LLM_BASE).replace(/\/$/, '')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { authorization: `Bearer ${llmKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: env.LLM_MODEL, temperature: 0.8, max_tokens: 180, messages: [{ role: 'user', content: prompt }] }),
    })
    if (!response.ok) return { send: false, thought, reason: `llm-${response.status}` }
    const body = await response.json()
    const content = body?.choices?.[0]?.message?.content || body?.choices?.[0]?.text || ''
    return parseDecision(content, thought)
  } catch (error) {
    return { send: false, thought, reason: error?.name === 'AbortError' ? 'llm-timeout' : 'llm-error' }
  } finally { clearTimeout(timeout) }
}

async function schedulePush(state, message, now) {
  if (!state.pushDevice) return false
  try {
    const response = await fetch(`${PUSH_BASE}/schedule`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device: state.pushDevice, id: message.id, at: now, title: state.roleName, body: message.text, url: state.pushUrl || '' }),
    })
    return response.ok
  } catch { return false }
}

async function runRole(env, roleId, now = Date.now()) {
  const advanced = advanceThoughts(await loadState(env, roleId, now), now)
  const gate = canAttemptWake(advanced, now)
  if (!gate.ok) { await saveState(env, advanced); return { roleId, sent: false, reason: gate.reason } }
  const decision = await askModel(env, advanced, gate.thought, now)
  const next = applyDecision(advanced, decision, now)
  await saveState(env, next)
  const message = next.inbox[next.inbox.length - 1]
  if (decision.send && message) await schedulePush(next, message, now)
  return { roleId, sent: Boolean(decision.send), reason: decision.reason || (decision.send ? 'sent' : 'model-no-send') }
}

const ALLOWED_ORIGINS = ['https://mxu88945-lgtm.github.io']
function corsHeaders(request) {
  const origin = request.headers.get('origin') || ''
  if (!ALLOWED_ORIGINS.includes(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return {}
  return { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '86400', vary: 'Origin' }
}

const worker = {
  async scheduled(_event, env, ctx) {
    const now = Date.now()
    const ids = await loadRoleIds(env)
    ctx.waitUntil(Promise.all(ids.map(roleId => runRole(env, roleId, now).catch(() => ({ roleId, sent: false, reason: 'worker-error' })))))
  },
  async fetch(request, env) {
    const cors = corsHeaders(request)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    const response = await worker.handleFetch(request, env)
    if (!Object.keys(cors).length) return response
    const headers = new Headers(response.headers)
    for (const [key, value] of Object.entries(cors)) headers.set(key, value)
    return new Response(response.body, { status: response.status, headers })
  },
  async handleFetch(request, env) {
    const url0 = new URL(request.url)
    // 一次性写入模型 Key：x-wake-key 验身份，Authorization 里是模型 Key（不回显）。
    if (url0.pathname === '/admin/llm-key' && request.method === 'POST') {
      const k = request.headers.get('x-wake-key') || ''
      if (!env.WAKE_KEY || k !== env.WAKE_KEY) return json({ ok: false, error: '未授权' }, 401)
      const auth = request.headers.get('authorization') || ''
      const value = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
      if (value.length < 8) return json({ ok: false, error: '缺少 Key' }, 400)
      await env.WAKE_STATE.put('config:llm-key', value)
      return json({ ok: true, length: value.length })
    }
    if (!authorized(request, env)) return json({ ok: false, error: '未授权' }, 401)
    const url = new URL(request.url)
    const now = Date.now()
    if (url.pathname === '/sync' && request.method === 'POST') {
      let body
      try { body = await request.json() } catch { return json({ ok: false, error: '请求体不是有效 JSON' }, 400) }
      const roleId = String(body?.roleId || '').trim().slice(0, 120)
      if (!roleId) return json({ ok: false, error: '缺少 roleId' }, 400)
      const current = await loadState(env, roleId, now)
      const next = recordChat({ ...current, roleId, roleName: body.roleName || current.roleName, personaSummary: body.personaSummary || current.personaSummary, recentSummary: body.recentSummary || current.recentSummary, pushDevice: body.pushDevice || current.pushDevice, pushUrl: body.pushUrl || current.pushUrl }, body.lastChatAt || now, now)
      await saveState(env, next); await registerRole(env, roleId)
      return json({ ok: true, state: publicState(next, now) })
    }
    if (url.pathname === '/inbox' && request.method === 'GET') {
      const roleId = String(url.searchParams.get('roleId') || '').trim()
      if (!roleId) return json({ ok: false, error: '缺少 roleId' }, 400)
      const state = await loadState(env, roleId, now)
      const messages = state.inbox.slice()
      state.inbox = []
      await saveState(env, state)
      return json({ ok: true, messages })
    }
    if (url.pathname === '/state' && request.method === 'GET') {
      const roleId = String(url.searchParams.get('roleId') || '').trim()
      if (!roleId) return json({ ok: false, error: '缺少 roleId' }, 400)
      return json({ ok: true, state: publicState(await loadState(env, roleId, now), now) })
    }
    return json({ ok: false, error: '未找到接口' }, 404)
  },
}

function publicState(state, now) {
  return { roleId: state.roleId, roleName: state.roleName, thoughts: state.thoughts, lastChatAt: state.lastChatAt, dailyDay: beijingDay(now), dailySent: state.dailySent, lastSentAt: state.lastSentAt, inboxCount: state.inbox.length }
}

export { runRole }
export default worker
