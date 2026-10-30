// Runs box/run-turn.mjs for real against a fake `claude` and a local stand-in for the Worker.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), '..', 'box', 'run-turn.mjs')

test('the answer is delivered and the lock freed while the transcript upload still hangs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-turn-'))
  const home = join(dir, 'home')
  const bin = join(dir, 'bin')
  const lock = join(dir, 'agent-turn.lock')
  const prompt = join(dir, 'prompt.txt')
  mkdirSync(join(home, '.claude', 'projects', 'p'), { recursive: true })
  writeFileSync(join(home, '.claude', 'projects', 'p', 'sess-1.jsonl'), '{"type":"user"}\n')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'claude'),
    `#!/bin/sh\necho '{"type":"result","is_error":false,"result":"hello","total_cost_usd":0.01}'\n`,
  )
  chmodSync(join(bin, 'claude'), 0o755)
  writeFileSync(prompt, 'hi')

  let callback: ((body: string) => void) | null = null
  const delivered = new Promise<string>((resolve) => (callback = resolve))
  const hanging: ServerResponse[] = []
  let uploadSeen: () => void = () => {}
  const uploadStarted = new Promise<void>((resolve) => (uploadSeen = resolve))
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/sandbox/transcript') {
      // A slow or mid-deploy Worker: the backup door never answers.
      req.resume()
      hanging.push(res)
      uploadSeen()
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.end('{"ok":true}')
      callback?.(body)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port

  const child = spawn(process.execPath, [RUNNER], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      TURN_ID: 'turn-1',
      SESSION_ID: 'sess-1',
      PROMPT_FILE: prompt,
      CALLBACK_URL: `http://127.0.0.1:${port}/sandbox/callback`,
      TRANSCRIPT_URL: `http://127.0.0.1:${port}/sandbox/transcript`,
      CALLBACK_TOKEN: 'tok',
      TURN_DEADLINE: String(Date.now() + 120_000),
      TURN_LOCK_FILE: lock,
    },
    stdio: 'ignore',
  })

  try {
    const body = await Promise.race([
      delivered,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('the answer waited on the transcript upload')), 10_000),
      ),
    ])
    assert.deepEqual(JSON.parse(body), { turnId: 'turn-1', ok: true, text: 'hello', costUsd: 0.01 })
    // The upload runs beside the answer (it may land a moment later) and still hangs.
    await uploadStarted
    assert.equal(hanging.length, 1)
    assert.equal(hanging[0].writableEnded, false)
    assert.equal(existsSync(lock), false, 'the next turn is not refused while the upload runs')
  } finally {
    child.kill('SIGKILL')
    for (const res of hanging) res.destroy()
    server.closeAllConnections()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
