import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { buildPrompt, sessionIdFor } from '../src/prompt.ts'
import { splitMessage, threadHistory, verifySlackSignature } from '../src/slack.ts'

const SECRET = 'slack-signing-secret'
const sign = (ts: string, body: string) => 'v0=' + createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')

test('accepts a correctly signed Slack request', async () => {
  const body = '{"type":"event_callback"}'
  assert.equal(await verifySlackSignature(SECRET, body, '1000', sign('1000', body), 1000), true)
})

test('refuses a bad signature, a missing one, and a replay older than 5 minutes', async () => {
  const body = '{}'
  assert.equal(await verifySlackSignature(SECRET, body, '1000', sign('1000', '{"x":1}'), 1000), false)
  assert.equal(await verifySlackSignature(SECRET, body, '1000', null, 1000), false)
  assert.equal(await verifySlackSignature(SECRET, body, '1000', sign('1000', body), 1000 + 301), false)
})

test('the session id is a stable UUID per thread', async () => {
  const a = await sessionIdFor('C1', '100.0')
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(await sessionIdFor('C1', '100.0'), a)
  assert.notEqual(await sessionIdFor('C1', '100.1'), a)
})

test('long replies split under the limit, on line breaks', () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')
  const parts = splitMessage(text, 1000)
  assert.ok(parts.length > 1)
  assert.ok(parts.every((p) => p.length <= 1000))
  assert.equal(parts.join('\n'), text)
  assert.deepEqual(splitMessage('   '), [])
})

test('the first turn includes the earlier thread messages', () => {
  const prompt = buildPrompt({
    messages: [{ ts: '2', user: 'U1', text: 'what do you think?' }],
    history: [{ ts: '1', user: 'U2', text: 'we should ship friday' }],
    githubEnabled: false,
  })
  assert.match(prompt, /<@U2>: we should ship friday[\s\S]*<@U1>: what do you think\?/)
  assert.match(prompt, /GitHub access is off/)
})

// Slack answers oldest first, 200 to a page, with the root at the top of every page.
function fakeThread(length: number) {
  const thread = Array.from({ length }, (_, i) => ({ ts: `${100 + i}.0`, user: 'U1', text: `message ${i + 1}` }))
  return async (_url: unknown, init: { body: URLSearchParams }) => {
    const from = Number(init.body.get('cursor') ?? 1)
    const next = from + Number(init.body.get('limit')) - 1
    const more = next < length
    const json = { ok: true, messages: [thread[0], ...thread.slice(from, next)], has_more: more, response_metadata: { next_cursor: more ? String(next) : '' } }
    return new Response(JSON.stringify(json), { headers: { 'Content-Type': 'application/json' } })
  }
}

test('threadHistory reads past the first page and keeps the first message and the newest', async (t) => {
  t.mock.method(globalThis, 'fetch', fakeThread(500))
  const { messages, leftOut } = await threadHistory({ SLACK_BOT_TOKEN: 'x' } as never, 'C1', '100.0', '599.0')
  assert.equal(messages.length, 30)
  assert.equal(messages[0].text, 'message 1')
  assert.equal(messages.at(-1)?.text, 'message 499')
  assert.equal(leftOut, 469)
})

test('threadHistory gives a short thread whole', async (t) => {
  t.mock.method(globalThis, 'fetch', fakeThread(10))
  const { messages, leftOut } = await threadHistory({ SLACK_BOT_TOKEN: 'x' } as never, 'C1', '100.0', '109.0')
  assert.equal(messages.length, 9)
  assert.equal(leftOut, 0)
})

test('the prompt says where history was left out', () => {
  const history = [
    { ts: '1.0', user: 'U1', text: 'first' },
    { ts: '9.0', user: 'U1', text: 'newest' },
  ]
  const prompt = buildPrompt({ messages: [], history, historyLeftOut: 7, githubEnabled: false })
  assert.match(prompt, /first\n\[7 message\(s\) left out here\]\n<@U1>: newest/)
})
