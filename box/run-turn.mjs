// Runs ONE Claude turn inside the sandbox, then posts the answer to the Worker.
//
// The Worker writes this file into the sandbox on every turn and starts it in the background
// (src/sandbox.ts). It runs with no Worker waiting on it, so it must ALWAYS report back, even when
// Claude crashes or runs out of time; otherwise the thread stays busy until its alarm gives up.
//
// Env (set by the Worker for this turn only):
//   TURN_ID, SESSION_ID, PROMPT_FILE, CALLBACK_URL, CALLBACK_TOKEN, TURN_DEADLINE
//   CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, and GH_TOKEN when GitHub is on.

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const env = process.env
const LOCK = '/tmp/agent-turn.lock'

// The Worker only starts one turn per thread at a time, but a queue retry can start the same one
// twice. A second runner must not touch the session: two `--resume` runs on one transcript break it.
const lock = takeLock()
if (lock.held) {
  if (lock.held === env.TURN_ID) {
    // The same turn, started twice by a queue retry. The first runner will report.
    console.error('this turn is already running; exiting')
    process.exit(0)
  }
  // An older turn still runs (its thread gave up on it). Say so, so this turn does not vanish.
  await report({ ok: false, error: 'my previous run is still going in this thread. Try again in a few minutes.' })
  process.exit(0)
}
const lockFd = lock.fd

/**
 * The lock holds the runner's pid and turn id. A lock left by a crashed runner is taken over; a
 * live one is reported as `held` with its turn id.
 */
function takeLock() {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(LOCK, 'wx')
      writeSync(fd, `${process.pid} ${env.TURN_ID}`)
      return { fd }
    } catch {
      const [pid, turnId] = readFileSync(LOCK, 'utf8').trim().split(' ')
      if (Number(pid) && isAlive(Number(pid))) return { held: turnId || 'unknown' }
      rmSync(LOCK, { force: true })
    }
  }
  return { held: 'unknown' }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let result = { ok: false, error: 'the run ended without a result' }
try {
  result = await runClaude()
} catch (err) {
  result = { ok: false, error: String(err?.message ?? err) }
} finally {
  closeSync(lockFd)
  rmSync(LOCK, { force: true })
  rmSync(env.PROMPT_FILE, { force: true })
}
await report(result)

async function runClaude() {
  // First turn creates the session, every later turn resumes it. The transcript file on disk is
  // the ground truth, so a paused-and-resumed sandbox picks up exactly where it left off.
  const sessionFlag = sessionExists(env.SESSION_ID) ? '--resume' : '--session-id'
  mkdirSync(join(homedir(), 'work'), { recursive: true })

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    // The sandbox IS the permission boundary: nothing on it matters beyond this thread.
    '--dangerously-skip-permissions',
    sessionFlag, env.SESSION_ID,
  ]

  return await new Promise((resolve) => {
    // Claude and every command it runs get the env WITHOUT the reply token: a prompt-injected
    // Claude must not be able to post its own "answer" and end the turn.
    const { CALLBACK_TOKEN: _t, CALLBACK_URL: _u, ...childEnv } = env
    const child = spawn('claude', args, {
      cwd: join(homedir(), 'work'),
      env: childEnv,
      stdio: [openSync(env.PROMPT_FILE, 'r'), 'pipe', 'pipe'],
    })

    let final = null
    let buffer = ''
    let stderrTail = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let i
      while ((i = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, i).trim()
        buffer = buffer.slice(i + 1)
        if (!line) continue
        try {
          const event = JSON.parse(line)
          if (event.type === 'result') final = event
        } catch {
          // not JSON; ignore
        }
      }
    })
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-2000)
    })

    // The deadline comes from the thread, which started counting when it accepted the message.
    const limit = Math.max(60_000, (Number(env.TURN_DEADLINE) || Date.now() + 45 * 60_000) - Date.now())
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref()
    }, limit)

    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        return resolve({ ok: false, error: 'the turn hit its time limit. Ask me to continue.' })
      }
      if (final && !final.is_error) {
        return resolve({ ok: true, text: final.result ?? '', costUsd: final.total_cost_usd })
      }
      const detail = final?.result || stderrTail.trim() || `claude exited with code ${code}`
      resolve({ ok: false, error: detail.slice(0, 1500) })
    })
  })
}

function sessionExists(id) {
  const projects = join(homedir(), '.claude', 'projects')
  if (!existsSync(projects)) return false
  return readdirSync(projects).some((dir) => existsSync(join(projects, dir, `${id}.jsonl`)))
}

async function report(result) {
  const body = JSON.stringify({ turnId: env.TURN_ID, ...result })
  // Retry for about 5 minutes: a Worker deploy or a blip must not lose a finished answer.
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const res = await fetch(env.CALLBACK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.CALLBACK_TOKEN}` },
        body,
      })
      if (res.ok) return
      // 4xx means the token was refused; retrying cannot fix that.
      if (res.status < 500) {
        console.error(`callback refused: ${res.status} ${await res.text()}`)
        return
      }
    } catch (err) {
      console.error(`callback attempt ${attempt} failed:`, err?.message ?? err)
    }
    await new Promise((r) => setTimeout(r, Math.min(60_000, 2_000 * 2 ** attempt)))
  }
  console.error('gave up delivering the answer')
}
