import assert from 'node:assert/strict'
import test from 'node:test'
import { applyDecision, advanceThoughts, canAttemptWake, isQuietTime, normalizeState, parseDecision, recordChat } from '../src/core.mjs'

const at = (hour, minute = 0, day = '2026-11-22') => Date.parse(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`)

test('心思会随沉默上涨，聊天后回落', () => {
  const start = normalizeState({ roleId: 'q', lastTickAt: at(10), thoughts: { 想念: .1, 分享欲: .1, 担心: .1, 好奇: .1 } }, at(10))
  const grown = advanceThoughts(start, at(12))
  assert.ok(grown.thoughts['想念'] > start.thoughts['想念'])
  const chatted = recordChat(grown, at(12), at(12))
  assert.ok(chatted.thoughts['想念'] < grown.thoughts['想念'])
})

test('北京时间静默时段为 00:30 到 08:00', () => {
  assert.equal(isQuietTime(at(0, 29)), false)
  assert.equal(isQuietTime(at(0, 30)), true)
  assert.equal(isQuietTime(at(7, 59)), true)
  assert.equal(isQuietTime(at(8, 0)), false)
})

test('最近聊天、三小时间隔和每日四条都会挡住唤醒', () => {
  const now = at(12)
  const base = normalizeState({ roleId: 'q', lastChatAt: now - 31 * 60 * 1000, lastSentAt: now - 4 * 60 * 60 * 1000, thoughts: { 想念: .8 } }, now)
  assert.equal(canAttemptWake(base, now).ok, true)
  assert.equal(canAttemptWake({ ...base, lastChatAt: now - 10 * 60 * 1000 }, now).reason, 'recent-chat')
  assert.equal(canAttemptWake({ ...base, lastSentAt: now - 2 * 60 * 60 * 1000 }, now).reason, 'message-gap')
  assert.equal(canAttemptWake({ ...base, dailyDay: '2026-11-22', dailySent: 4 }, now).reason, 'daily-limit')
})

test('低于阈值不唤醒，超过阈值才进入模型判断', () => {
  const now = at(12)
  const low = normalizeState({ roleId: 'q', lastChatAt: now - 2 * 60 * 60 * 1000, lastSentAt: now - 4 * 60 * 60 * 1000, thoughts: { 想念: .2 } }, now)
  assert.equal(canAttemptWake(low, now).reason, 'below-threshold')
  const high = { ...low, thoughts: { ...low.thoughts, 想念: .8 } }
  assert.equal(canAttemptWake(high, now).ok, true)
})

test('不发分支不会写入收件箱，发出分支只写一条', () => {
  const now = at(12)
  const state = normalizeState({ roleId: 'q', thoughts: { 想念: .8 } }, now)
  assert.equal(parseDecision('不发', '想念').send, false)
  const silent = applyDecision(state, { send: false, thought: '想念' }, now)
  assert.equal(silent.inbox.length, 0)
  const sent = applyDecision(state, { send: true, thought: '想念', text: '我刚刚想起你了。' }, now)
  assert.equal(sent.inbox.length, 1)
  assert.equal(sent.dailySent, 1)
})
