// Runs ONE Claude turn inside the sandbox, then posts the answer to the Worker.
//
// The Worker writes this file into the sandbox on every turn and starts it in the background
// (src/sandbox.ts). It runs with no Worker waiting on it, so it must ALWAYS report back, even when
// Claude crashes or runs out of time; otherwise the thread stays busy until its alarm gives up.
//
// After Claude stops it reads the thread's transcript (still holding the turn lock), frees the lock,
// then posts the answer and uploads the transcript copy to the Worker's /sandbox/transcript door
// (stored in R2) side by side. The upload never delays the answer or eats into the time report()
// has to deliver it before the thread's lost-turn alarm, and a failed backup never fails the turn.
//
// While Claude runs, a ticker tells the Worker's /sandbox/progress door what Claude is doing (for
// the live status message in Slack) every few seconds, and the answer says whether someone pressed
// Stop. On a stop it ends Claude and reports `stopped`, which is what frees the thread.
//
// Env (set by the Worker for this turn only):
//   TURN_ID, SESSION_ID, PROMPT_FILE, CALLBACK_URL, CALLBACK_TOKEN, TRANSCRIPT_URL, PROGRESS_URL,
//   TURN_DEADLINE,
//   CLAUDE_MODEL (the model id for --model)
//   CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, and GH_TOKEN when GitHub is on.

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { createProgress, onStreamEvent, shouldSendStatus, TICK_MS } from './progress.mjs'

const env = process.env
// TURN_LOCK_FILE and PROGRESS_TICK_MS exist for the runner's tests only.
const LOCK = env.TURN_LOCK_FILE || '/tmp/agent-turn.lock'

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
let snapshot = null
try {
  result = await runClaude()
} catch (err) {
  result = { ok: false, error: String(err?.message ?? err) }
} finally {
  // Still holding the lock, so no next turn is writing to the transcript while it is read. Only
  // the read happens here: the upload runs after the lock is freed, so the next turn is not refused.
  snapshot = snapshotTranscript()
  closeSync(lockFd)
  rmSync(LOCK, { force: true })
  rmSync(env.PROMPT_FILE, { force: true })
}
// The answer goes first and never waits on the backup: report() needs all of the thread's
// lost-turn margin (src/thread.ts LOST_TURN_MARGIN_MS) for its retries.
await Promise.all([report(result), uploadTranscript(snapshot)])

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
    // The thread's `!model` pick, mapped to an id by the Worker (src/models.ts).
    ...(env.CLAUDE_MODEL ? ['--model', env.CLAUDE_MODEL] : []),
  ]

  return await new Promise((resolve) => {
    // Claude and every command it runs get the env WITHOUT the reply token: a prompt-injected
    // Claude must not be able to post its own "answer" and end the turn.
    const { CALLBACK_TOKEN: _t, CALLBACK_URL: _u, TRANSCRIPT_URL: _x, PROGRESS_URL: _p, ...childEnv } = env
    const child = spawn('claude', args, {
      cwd: join(homedir(), 'work'),
      env: childEnv,
      stdio: [openSync(env.PROMPT_FILE, 'r'), 'pipe', 'pipe'],
    })

    let final = null
    let buffer = ''
    let stderrTail = ''

    // The live status. `version` counts changes, so a tick knows whether it has news to send.
    const progress = createProgress()
    let version = 1
    let sentVersion = 0
    let lastSentAt = 0
    let ticking = false
    let stopped = false
    const ticker = env.PROGRESS_URL ? setInterval(tick, Number(env.PROGRESS_TICK_MS) || TICK_MS) : null

    async function tick() {
      if (ticking || stopped) return
      ticking = true
      const now = Date.now()
      const at = version
      const send = shouldSendStatus({ changed: at !== sentVersion, lastSentAt, now })
      try {
        const res = await fetch(env.PROGRESS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${env.CALLBACK_TOKEN}` },
          // Only what Claude is doing. The Worker reads the thread and the clock from its own records.
          body: JSON.stringify({ turnId: env.TURN_ID, ...(send ? { activity: progress.activity, steps: progress.steps } : {}) }),
          signal: AbortSignal.timeout(15_000),
        })
        if (res.ok) {
          if (send) {
            sentVersion = at
            lastSentAt = now
          }
          const answer = await res.json().catch(() => ({}))
          if (answer?.stop) stop()
        }
      } catch {
        // A missed tick costs one status edit; the next tick tries again.
      } finally {
        ticking = false
      }
    }

    // Someone pressed Stop. End Claude the same way the time limit does.
    function stop() {
      if (stopped) return
      stopped = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref()
    }
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
          if (onStreamEvent(progress, event)) version++
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
      if (ticker) clearInterval(ticker)
      if (timedOut) {
        return resolve({ ok: false, error: 'the turn hit its time limit. Ask me to continue.' })
      }
      // An answer that was already finished when Stop landed is still worth delivering.
      if (final && !final.is_error) {
        return resolve({ ok: true, text: final.result ?? '', costUsd: final.total_cost_usd })
      }
      if (stopped) return resolve({ ok: false, stopped: true, error: 'stopped' })
      const detail = final?.result || stderrTail.trim() || `claude exited with code ${code}`
      resolve({ ok: false, error: detail.slice(0, 1500) })
    })
  })
}

function sessionExists(id) {
  return transcriptPath(id) !== null
}

/** Claude Code keeps a session at ~/.claude/projects/<folder>/<sessionId>.jsonl. */
function transcriptPath(id) {
  const projects = join(homedir(), '.claude', 'projects')
  if (!existsSync(projects)) return null
  for (const dir of readdirSync(projects)) {
    const path = join(projects, dir, `${id}.jsonl`)
    if (existsSync(path)) return path
  }
  return null
}

/** The whole transcript, gzipped, or null when there is none (or no door to send it to). */
function snapshotTranscript() {
  try {
    const path = env.TRANSCRIPT_URL && transcriptPath(env.SESSION_ID)
    return path ? gzipSync(readFileSync(path)) : null
  } catch (err) {
    console.error('transcript backup failed:', err?.message ?? err)
    return null
  }
}

/**
 * Uploads the snapshot. The Worker picks the R2 key from the token, so this sends only the bytes.
 * A few quick tries, then it gives up: the answer matters more than the backup.
 */
async function uploadTranscript(body) {
  if (!body) return
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(env.TRANSCRIPT_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/gzip',
            authorization: `Bearer ${env.CALLBACK_TOKEN}`,
            'x-turn-id': env.TURN_ID,
          },
          body,
          signal: AbortSignal.timeout(60_000),
        })
        if (res.ok) return
        console.error(`transcript upload refused: ${res.status} ${await res.text()}`)
        if (res.status < 500) return
      } catch (err) {
        console.error(`transcript upload attempt ${attempt} failed:`, err?.message ?? err)
      }
      await new Promise((r) => setTimeout(r, 2_000 * attempt))
    }
  } catch (err) {
    console.error('transcript backup failed:', err?.message ?? err)
  }
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
