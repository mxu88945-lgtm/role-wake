export const THOUGHT_KEYS = ['想念', '分享欲', '担心', '好奇']
export const DEFAULT_THOUGHTS = Object.freeze({ 想念: 0, 分享欲: 0, 担心: 0, 好奇: 0 })
export const THOUGHT_THRESHOLD = 0.65
export const HALF_HOUR_MS = 30 * 60 * 1000
export const QUIET_START_MINUTE = 30
export const QUIET_END_MINUTE = 8 * 60
export const MIN_GAP_MS = 3 * 60 * 60 * 1000
export const RECENT_CHAT_GUARD_MS = 30 * 60 * 1000
export const MAX_DAILY_MESSAGES = 4

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : min))

export function beijingParts(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(now))
  const get = type => Number(parts.find(item => item.type === type)?.value || 0)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') }
}

export function beijingDay(now = Date.now()) {
  const p = beijingParts(now)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

export function isQuietTime(now = Date.now()) {
  const p = beijingParts(now)
  const minute = p.hour * 60 + p.minute
  return minute >= QUIET_START_MINUTE && minute < QUIET_END_MINUTE
}

export function normalizeState(input = {}, now = Date.now()) {
  const thoughts = Object.fromEntries(THOUGHT_KEYS.map(key => [key, clamp(input.thoughts?.[key])]))
  const day = beijingDay(now)
  return {
    roleId: String(input.roleId || ''),
    roleName: String(input.roleName || '角色').slice(0, 80),
    personaSummary: String(input.personaSummary || '').slice(0, 6000),
    recentSummary: String(input.recentSummary || '').slice(0, 4000),
    lastChatAt: Number(input.lastChatAt || 0),
    lastTickAt: Number(input.lastTickAt || now),
    lastDecisionAt: Number(input.lastDecisionAt || 0),
    lastSentAt: Number(input.lastSentAt || 0),
    dailyDay: input.dailyDay || day,
    dailySent: input.dailyDay === day ? Math.max(0, Math.floor(Number(input.dailySent) || 0)) : 0,
    thoughts,
    inbox: Array.isArray(input.inbox) ? input.inbox.slice(-12) : [],
  }
}

export function advanceThoughts(state, now = Date.now()) {
  const next = normalizeState(state, now)
  const elapsed = Math.max(0, now - next.lastTickAt)
  const halfHours = elapsed / HALF_HOUR_MS
  if (halfHours > 0) {
    // 四种心思的涨速略有差异，但都以“距离上次聊天更久”为主要来源。
    const rates = { 想念: 0.055, 分享欲: 0.045, 担心: 0.035, 好奇: 0.04 }
    for (const key of THOUGHT_KEYS) next.thoughts[key] = clamp(next.thoughts[key] + halfHours * rates[key])
  }
  next.lastTickAt = now
  return next
}

export function recordChat(state, lastChatAt, now = Date.now()) {
  const next = advanceThoughts(state, now)
  next.lastChatAt = Number(lastChatAt || now)
  // 聊过天后回落，但保留一点人格底色，避免每次都从零开始。
  next.thoughts = { 想念: 0.12, 分享欲: 0.08, 担心: 0.05, 好奇: 0.08 }
  next.lastDecisionAt = 0
  return next
}

export function pickThought(state) {
  return THOUGHT_KEYS.reduce((best, key) => state.thoughts[key] > state.thoughts[best] ? key : best, THOUGHT_KEYS[0])
}

export function canAttemptWake(state, now = Date.now()) {
  const current = normalizeState(state, now)
  if (isQuietTime(now)) return { ok: false, reason: 'quiet-hours' }
  if (current.lastChatAt && now - current.lastChatAt < RECENT_CHAT_GUARD_MS) return { ok: false, reason: 'recent-chat' }
  if (current.lastSentAt && now - current.lastSentAt < MIN_GAP_MS) return { ok: false, reason: 'message-gap' }
  if (current.dailySent >= MAX_DAILY_MESSAGES) return { ok: false, reason: 'daily-limit' }
  const thought = pickThought(current)
  if (current.thoughts[thought] < THOUGHT_THRESHOLD) return { ok: false, reason: 'below-threshold', thought }
  return { ok: true, thought, score: current.thoughts[thought] }
}

export function applyDecision(state, decision, now = Date.now()) {
  const next = advanceThoughts(state, now)
  next.lastDecisionAt = now
  if (decision?.send && decision.text) {
    next.lastSentAt = now
    next.dailySent += 1
    next.thoughts[decision.thought || pickThought(next)] = 0.12
    next.inbox.push({ id: crypto.randomUUID(), roleId: next.roleId, text: String(decision.text).trim().slice(0, 600), thought: decision.thought || pickThought(next), ts: now })
    next.inbox = next.inbox.slice(-12)
  }
  return next
}

export function parseDecision(raw, thought) {
  const text = String(raw || '').trim()
  if (!text || /^不发[。！!、,.，]?$/u.test(text) || /^NO_SEND$/i.test(text)) return { send: false, thought }
  const cleaned = text.replace(/^(发|发送|说|消息)\s*[:：]\s*/u, '').replace(/^['"“”]+|['"“”]+$/g, '').trim()
  if (!cleaned || cleaned === '不发') return { send: false, thought }
  return { send: true, thought, text: cleaned.slice(0, 600) }
}
