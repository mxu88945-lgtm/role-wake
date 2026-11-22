import assert from 'node:assert/strict'
import test from 'node:test'
import { runRole } from '../src/index.mjs'

class MemoryKV {
  constructor() { this.values = new Map() }
  async get(key, type) {
    const value = this.values.get(key)
    if (value == null) return null
    return type === 'json' ? JSON.parse(value) : value
  }
  async put(key, value) { this.values.set(key, value) }
}
const at = (hour, minute = 0, day = '2026-11-22') => Date.parse(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`)
const makeEnv = (state, pushResponse = new Response('{}', { status: 200 })) => {
  const kv = new MemoryKV()
  kv.values.set(`role:${encodeURIComponent(state.roleId)}`, JSON.stringify(state))
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    if (String(url).includes('/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: '我刚刚想起你了。' } }] }), { status: 200 })
    if (String(url).includes('push.zhouweiweihome.top')) {
      if (pushResponse instanceof Error) throw pushResponse
      return pushResponse
    }
    throw new Error('unexpected url')
  }
  return [{ WAKE_STATE: kv, LLM_BASE: 'https://llm.example', LLM_MODEL: 'test', LLM_KEY: 'llm-secret' }, calls, kv]
}
const readyState = (extra = {}) => ({ roleId: 'q', roleName: '顾祁砚', lastTickAt: at(10), lastChatAt: at(8), lastSentAt: at(8), thoughts: { 想念: .8, 分享欲: .1, 担心: .1, 好奇: .1 }, ...extra })

test('有 device 会按唯一消息 ID 调度手机通知', async () => {
  const [env, calls, kv] = makeEnv(readyState({ pushDevice: 'device-1', pushUrl: 'https://example.com/app' }))
  const result = await runRole(env, 'q', at(12))
  assert.equal(result.sent, true)
  const push = calls.find((call) => String(call.url).includes('/schedule'))
  assert.ok(push)
  const body = JSON.parse(push.options.body)
  const saved = JSON.parse(await kv.get('role:q'))
  assert.equal(body.device, 'device-1')
  assert.equal(body.at, at(12))
  assert.equal(body.title, '顾祁砚')
  assert.equal(body.body, saved.inbox[0].text)
  assert.equal(body.id, saved.inbox[0].id)
  assert.equal(body.url, 'https://example.com/app')
})

test('没有 device 不发手机通知但仍写入 inbox', async () => {
  const [env, calls, kv] = makeEnv(readyState())
  const result = await runRole(env, 'q', at(12))
  assert.equal(result.sent, true)
  assert.equal(calls.filter((call) => String(call.url).includes('/schedule')).length, 0)
  assert.equal(JSON.parse(await kv.get('role:q')).inbox.length, 1)
})

test('推送失败不影响 inbox 写入', async () => {
  const [env, calls, kv] = makeEnv(readyState({ pushDevice: 'device-1' }), new Error('push down'))
  const result = await runRole(env, 'q', at(12))
  assert.equal(result.sent, true)
  assert.equal(calls.filter((call) => String(call.url).includes('/schedule')).length, 1)
  assert.equal(JSON.parse(await kv.get('role:q')).inbox.length, 1)
})

test('同一轮消息只生成一个唯一 ID 并只调度一次', async () => {
  const [env, calls, kv] = makeEnv(readyState({ pushDevice: 'device-1' }))
  await runRole(env, 'q', at(12))
  const saved = JSON.parse(await kv.get('role:q'))
  assert.equal(new Set(saved.inbox.map((item) => item.id)).size, saved.inbox.length)
  assert.equal(calls.filter((call) => String(call.url).includes('/schedule')).length, 1)
})
