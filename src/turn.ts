import { signCallbackToken } from './callback-token.ts'
import { claudeAuth, maxTurnMs, type Env } from './env.ts'
import { githubConfigured, mintInstallationToken } from './github.ts'
import { buildPrompt, sessionIdFor } from './prompt.ts'
import { modelId } from './models.ts'
import { launchTurn } from './sandbox.ts'
import { deleteMessage, postInThread, postMessage, react, threadHistory } from './slack.ts'
import { followUrl, statusBlocks, statusLine } from './status.ts'
import { threadStub } from './thread-state.ts'
import type { ThreadData, Turn } from './thread.ts'

export interface TurnJob {
  channel: string
  threadTs: string
  origin: string
  turn: Turn
}

export const WORKING_EMOJI = 'eyes'
export const DONE_EMOJI = 'white_check_mark'
export const FAILED_EMOJI = 'x'
export const QUEUED_EMOJI = 'hourglass_flowing_sand'
export const STOPPED_EMOJI = 'octagonal_sign'

/** How long the reply token outlives the turn limit, for a slow last upload. */
const TOKEN_GRACE_MS = 10 * 60_000

export async function enqueueTurn(env: Env, data: ThreadData, turn: Turn) {
  await env.TURNS.send({ channel: data.channel, threadTs: data.threadTs, origin: data.origin, turn })
}

/**
 * Starts one turn: gathers the prompt, mints the short-lived tokens, launches Claude in the sandbox.
 * Throws to let the queue retry. On the last attempt it tells the thread and frees it instead.
 */
export async function runTurnJob(env: Env, job: TurnJob, attempt: number, maxAttempts: number) {
  const { channel, threadTs, turn } = job
  const lastTs = turn.messages.at(-1)!.ts
  try {
    await react(env, channel, lastTs, WORKING_EMOJI)
    // Messages that waited for this turn wore an hourglass; they are being read now.
    await Promise.all(turn.messages.map((m) => react(env, channel, m.ts, null, QUEUED_EMOJI)))
    await postStatus(env, job)

    const auth = claudeAuth(env)
    if ('missing' in auth) throw new Fatal(auth.missing)

    let githubToken: string | null = null
    let githubNote = ''
    if (githubConfigured(env)) {
      try {
        githubToken = await mintInstallationToken(env)
      } catch (err) {
        // A broken GitHub setup costs the turn its GitHub access, not its answer.
        console.error('github token mint failed:', err)
        githubNote = `\n(GitHub access failed for this turn: ${(err as Error).message})`
      }
    }

    const history = turn.firstTurn ? await threadHistory(env, channel, threadTs, turn.messages[0].ts) : []
    const prompt = buildPrompt({ messages: turn.messages, history, githubEnabled: Boolean(githubToken) }) + githubNote

    // The time limit counts from when the thread started the turn, not from this launch, so a
    // launch delayed by queue retries cannot outlive the thread's lost-turn alarm.
    const deadline = turn.startedAt + maxTurnMs(env)
    const callbackToken = await signCallbackToken(env.CALLBACK_SECRET, {
      channel,
      threadTs,
      turnId: turn.turnId,
      lastTs,
      exp: deadline + TOKEN_GRACE_MS,
    })

    await launchTurn(env, {
      channel,
      threadTs,
      turnId: turn.turnId,
      sessionId: await sessionIdFor(channel, threadTs),
      prompt,
      callbackUrl: new URL('/sandbox/callback', job.origin).toString(),
      callbackToken,
      transcriptUrl: new URL('/sandbox/transcript', job.origin).toString(),
      progressUrl: new URL('/sandbox/progress', job.origin).toString(),
      // A job queued before models existed has no model; modelId falls back to the default.
      model: modelId(turn.model),
      claudeEnvs: auth.envs,
      githubToken,
      deadline,
    })
  } catch (err) {
    // A wrong key or a missing secret fails the same way on every retry; say so at once.
    const fatal = err instanceof Fatal || (err as Error)?.name === 'AuthenticationError'
    if (!fatal && attempt < maxAttempts) throw err
    console.error(`turn ${turn.turnId} could not start:`, err)
    await postInThread(env, channel, threadTs, `:x: I could not start: ${(err as Error).message}`).catch(() => {})
    await react(env, channel, lastTs, FAILED_EMOJI, WORKING_EMOJI)
    // Free the thread, and start the next turn if messages arrived meanwhile.
    const done = await threadStub(env, channel, threadTs).finish(turn.turnId)
    if (done.accepted && done.statusTs) await deleteMessage(env, channel, done.statusTs)
  }
}

/**
 * Posts the turn's live status message with its Stop button (src/status.ts), once per turn: a
 * retried job finds the one it already posted. A status message is a nicety, so a failure here
 * costs the turn its status line, never its answer.
 */
async function postStatus(env: Env, job: TurnJob) {
  const { channel, threadTs, turn } = job
  const thread = threadStub(env, channel, threadTs)
  try {
    if (await thread.statusOf(turn.turnId)) return
    const ts = await postMessage(env, {
      channel,
      thread_ts: threadTs,
      text: 'Working…',
      blocks: statusBlocks({
        line: statusLine({ elapsedMs: Date.now() - turn.startedAt }),
        followUrl: followUrl(job.origin, channel, threadTs),
        turnId: turn.turnId,
      }),
    })
    // The turn may have ended while the post was in flight; then nobody else will delete it.
    if (!(await thread.setStatus(turn.turnId, ts))) await deleteMessage(env, channel, ts)
  } catch (err) {
    console.warn(`turn ${turn.turnId}: could not post the status message:`, (err as Error).message)
  }
}

/** A failure a retry cannot fix, such as a missing secret. */
class Fatal extends Error {}
