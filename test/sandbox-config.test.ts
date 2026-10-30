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
  assert.match(runner, /const { CALLBACK_TOKEN: _t, CALLBACK_URL: _u, \.\.\.childEnv } = env/)
  assert.match(runner, /env: childEnv,/)
})
