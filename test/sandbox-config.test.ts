// I-4: a sandbox is paused, never killed, on timeout, so the thread's Claude transcript survives.
// Read from disk because src/sandbox.ts imports text modules that only Wrangler can load.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sandbox.ts'), 'utf8')

test("sandboxes are created with onTimeout: 'pause'", () => {
  assert.match(source, /lifecycle:\s*{\s*onTimeout:\s*'pause'\s*}/)
})

test('turns are launched detached with the 60-second default timeout turned off', () => {
  assert.match(source, /background:\s*true,\s*\n\s*timeoutMs:\s*0/)
})

test('the Slack bot token is never handed to a sandbox', () => {
  assert.doesNotMatch(source, /SLACK_BOT_TOKEN|SLACK_SIGNING_SECRET|CALLBACK_SECRET/)
})

test('Claude in the sandbox never gets the reply token', () => {
  const runner = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'box', 'run-turn.mjs'), 'utf8')
  assert.match(runner, /const { CALLBACK_TOKEN: _t, CALLBACK_URL: _u, TRANSCRIPT_URL: _x, PROGRESS_URL: _p, \.\.\.childEnv } = env/)
  assert.match(runner, /env: childEnv,/)
})

test('the runner passes the thread model to claude and backs up the transcript without delaying the answer', () => {
  const runner = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'box', 'run-turn.mjs'), 'utf8')
  assert.match(runner, /\['--model', env\.CLAUDE_MODEL\]/)
  // The upload sends no key or path: the Worker builds the key from the token.
  assert.match(runner, /'x-turn-id': env\.TURN_ID/)
  // The transcript is read under the lock; the upload runs beside the answer, never before it
  // (test/run-turn.test.ts runs the runner against a hanging upload).
  assert.ok(runner.indexOf('snapshot = snapshotTranscript()') < runner.lastIndexOf('rmSync(LOCK, { force: true })'))
  assert.match(runner, /await Promise\.all\(\[report\(result\), uploadTranscript\(snapshot\)\]\)/)
})

test('the sandbox gets the model and the transcript door', () => {
  assert.match(source, /TRANSCRIPT_URL: launch\.transcriptUrl/)
  assert.match(source, /CLAUDE_MODEL: launch\.model/)
})

test('the sandbox gets the progress door and the helper the runner imports', () => {
  assert.match(source, /PROGRESS_URL: launch\.progressUrl/)
  assert.match(source, /{ path: PROGRESS_PATH, data: PROGRESS }/)
  const runner = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'box', 'run-turn.mjs'), 'utf8')
  assert.match(runner, /from '\.\/progress\.mjs'/)
})
