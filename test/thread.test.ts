// I-3: one turn at a time per thread; each Slack message runs once; a thread starts with a mention.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { abortStart, accept, afterPause, emptyThread, finish, LOST_TURN_MARGIN_MS, onAlarm, requeue, type ThreadData } from '../src/thread.ts'

function ids() {
  let n = 0
  return () => `turn-${++n}`
}
const msg = (ts: string, text = 'hi') => ({ ts, user: 'U1', text })
const fresh = () => emptyThread('C1', '100.0', 'https://agent.example')

test('a mention starts the first turn', () => {
  const data = fresh()
  const r = accept(data, msg('100.0'), { mention: true, now: 1, newTurnId: ids() })
  assert.equal(r.action, 'start')
  if (r.action === 'start') assert.equal(r.turn.firstTurn, true)
})

test('a reply without a mention in an unknown thread is skipped', () => {
  const data = fresh()
  assert.deepEqual(accept(data, msg('101.0'), { mention: false, now: 1, newTurnId: ids() }), {
    action: 'skip',
    reason: 'not-our-thread',
  })
})

test('the same message arriving twice (app_mention + message) runs once', () => {
  const data = fresh()
  const newTurnId = ids()
  assert.equal(accept(data, msg('100.0'), { mention: true, now: 1, newTurnId }).action, 'start')
  assert.deepEqual(accept(data, msg('100.0'), { mention: true, now: 2, newTurnId }), { action: 'skip', reason: 'duplicate' })
})

test('two messages at once give one running turn; the second waits and runs next', () => {
  const data = fresh()
  const newTurnId = ids()
  const first = accept(data, msg('100.0'), { mention: true, now: 1, newTurnId })
  const second = accept(data, msg('100.5', 'and also'), { mention: true, now: 1, newTurnId })
  assert.equal(first.action, 'start')
  assert.deepEqual(second, { action: 'queued' })

  const done = finish(data, 'turn-1', { now: 5, newTurnId })
  assert.equal(done.accepted, true)
  if (done.accepted) {
    assert.equal(done.next?.turnId, 'turn-2')
    assert.deepEqual(done.next?.messages.map((m) => m.ts), ['100.5'])
    assert.equal(done.next?.firstTurn, false)
  }
  assert.equal(data.running?.turnId, 'turn-2')
})

test('follow-ups in a known thread need no mention', () => {
  const data = fresh()
  const newTurnId = ids()
  accept(data, msg('100.0'), { mention: true, now: 1, newTurnId })
  finish(data, 'turn-1', { now: 2, newTurnId })
  const r = accept(data, msg('102.0'), { mention: false, now: 3, newTurnId })
  assert.equal(r.action, 'start')
})

test('finishing a turn that is not running is refused (a retried callback cannot free the next turn)', () => {
  const data = fresh()
  const newTurnId = ids()
  accept(data, msg('100.0'), { mention: true, now: 1, newTurnId })
  assert.deepEqual(finish(data, 'turn-999', { now: 2, newTurnId }), { accepted: false })
  assert.equal(finish(data, 'turn-1', { now: 2, newTurnId }).accepted, true)
  assert.deepEqual(finish(data, 'turn-1', { now: 3, newTurnId }), { accepted: false })
})

test('the alarm pauses a quiet thread once, and waits on a busy one', () => {
  const data: ThreadData = fresh()
  const newTurnId = ids()
  const opts = { maxTurnMs: 1000, idlePauseMs: 100, newTurnId }
  accept(data, msg('100.0'), { mention: true, now: 0, newTurnId })
  assert.deepEqual(onAlarm(data, { ...opts, now: 500 }), { action: 'wait', until: 1000 + LOST_TURN_MARGIN_MS })

  finish(data, 'turn-1', { now: 600, newTurnId })
  assert.deepEqual(onAlarm(data, { ...opts, now: 650 }), { action: 'wait', until: 700 })
  assert.deepEqual(onAlarm(data, { ...opts, now: 700 }), { action: 'pause' })
  assert.deepEqual(onAlarm(data, { ...opts, now: 900 }), { action: 'none' })
})

test('a turn that never reports back is freed after its limit, and waiting messages run', () => {
  const data = fresh()
  const newTurnId = ids()
  accept(data, msg('100.0'), { mention: true, now: 0, newTurnId })
  accept(data, msg('100.5'), { mention: true, now: 10, newTurnId })
  const r = onAlarm(data, { now: 1000 + LOST_TURN_MARGIN_MS, maxTurnMs: 1000, idlePauseMs: 100, newTurnId })
  assert.equal(r.action, 'stale')
  if (r.action === 'stale') {
    assert.equal(r.lostTurnId, 'turn-1')
    assert.equal(r.next?.turnId, 'turn-2')
  }
})

test('rule 4: a message during a pause waits, and runs once the pause returns', () => {
  const data = fresh()
  const newTurnId = ids()
  const opts = { maxTurnMs: 1000, idlePauseMs: 100, newTurnId }
  accept(data, msg('100.0'), { mention: true, now: 0, newTurnId })
  finish(data, 'turn-1', { now: 10, newTurnId })
  assert.deepEqual(onAlarm(data, { ...opts, now: 200 }), { action: 'pause' })
  assert.equal(data.pausing, true)

  assert.deepEqual(accept(data, msg('300.0'), { mention: false, now: 300, newTurnId }), { action: 'queued' })
  const next = afterPause(data, { paused: true, now: 400, newTurnId })
  assert.equal(next?.turnId, 'turn-2')
  assert.equal(data.pausing, false)
  assert.equal(data.parked, false, 'a thread with a turn starting is not parked')
})

test('a pause with nothing waiting parks the thread; a failed pause leaves it awake for a retry', () => {
  const ok = fresh()
  const newTurnId = ids()
  accept(ok, msg('100.0'), { mention: true, now: 0, newTurnId })
  finish(ok, 'turn-1', { now: 10, newTurnId })
  onAlarm(ok, { maxTurnMs: 1000, idlePauseMs: 100, now: 200, newTurnId })
  assert.equal(afterPause(ok, { paused: true, now: 210, newTurnId }), null)
  assert.equal(ok.parked, true)

  const failed = fresh()
  accept(failed, msg('100.0'), { mention: true, now: 0, newTurnId })
  finish(failed, 'turn-2', { now: 10, newTurnId })
  onAlarm(failed, { maxTurnMs: 1000, idlePauseMs: 100, now: 200, newTurnId })
  afterPause(failed, { paused: false, now: 210, newTurnId })
  assert.equal(failed.parked, false)
  assert.deepEqual(onAlarm(failed, { maxTurnMs: 1000, idlePauseMs: 100, now: 300, newTurnId }), { action: 'pause' })
})

test('a turn whose job could not be queued is undone, so Slack retrying the event runs it', () => {
  const data = fresh()
  const newTurnId = ids()
  const r = accept(data, msg('100.0'), { mention: true, now: 0, newTurnId })
  assert.equal(r.action, 'start')
  if (r.action !== 'start') return
  abortStart(data, r.turn)
  assert.equal(data.running, null)
  const retry = accept(data, msg('100.0'), { mention: true, now: 5, newTurnId })
  assert.equal(retry.action, 'start')
  if (retry.action === 'start') assert.equal(retry.turn.firstTurn, true)
})

test('a next turn that could not be queued goes back to pending, and the alarm starts it', () => {
  const data = fresh()
  const newTurnId = ids()
  accept(data, msg('100.0'), { mention: true, now: 0, newTurnId })
  accept(data, msg('100.5'), { mention: true, now: 1, newTurnId })
  const done = finish(data, 'turn-1', { now: 5, newTurnId })
  if (!done.accepted || !done.next) throw new Error('expected a next turn')
  requeue(data, done.next)
  assert.equal(data.running, null)
  const r = onAlarm(data, { maxTurnMs: 1000, idlePauseMs: 100, now: 20, newTurnId })
  assert.equal(r.action, 'start')
  if (r.action === 'start') assert.deepEqual(r.next.messages.map((m) => m.ts), ['100.5'])
})

test('a turn records when it started, for the deadline', () => {
  const data = fresh()
  const r = accept(data, msg('100.0'), { mention: true, now: 1234, newTurnId: ids() })
  if (r.action === 'start') assert.equal(r.turn.startedAt, 1234)
})
