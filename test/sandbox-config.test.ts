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
  assert.match(runner, /const { CALLBACK_TOKEN: _t, CALLBACK_URL: _u, TRANSCRIPT_URL: _x, \.\.\.childEnv } = env/)
  assert.match(runner, /env: childEnv,/)
})

test('the runner passes the thread model to claude and backs up the transcript before it reports', () => {
  const runner = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'box', 'run-turn.mjs'), 'utf8')
  assert.match(runner, /\['--model', env\.CLAUDE_MODEL\]/)
  // The upload sends no key or path: the Worker builds the key from the token.
  assert.match(runner, /'x-turn-id': env\.TURN_ID/)
  assert.ok(runner.indexOf('await backupTranscript()') < runner.indexOf('await report(result)'))
})

test('the sandbox gets the model and the transcript door', () => {
  assert.match(source, /TRANSCRIPT_URL: launch\.transcriptUrl/)
  assert.match(source, /CLAUDE_MODEL: launch\.model/)
})
