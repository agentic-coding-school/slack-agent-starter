import { verifyCallbackToken } from './callback-token.ts'
import { recordTranscript } from './db.ts'
import type { Env } from './env.ts'
import { parseModelCommand } from './models.ts'
import { deleteMessage, postInThread, react, updateMessage, verifySlackSignature } from './slack.ts'
import { followUrl, parseStopClick, statusBlocks, statusLine } from './status.ts'
import { threadStub } from './thread-state.ts'
import { checkTranscriptSize, transcriptKey } from './transcripts.ts'
import { DONE_EMOJI, FAILED_EMOJI, QUEUED_EMOJI, runTurnJob, STOPPED_EMOJI, WORKING_EMOJI, type TurnJob } from './turn.ts'

export { ThreadState } from './thread-state.ts'

/**
 * The ways in:
 *
 *   POST /slack/events      Slack's Events API. Answers within Slack's 3 seconds and queues the work.
 *   POST /slack/interactive Slack's button clicks: the Stop button on a running turn.
 *   POST /sandbox/callback  A sandbox delivering one turn's answer, with its one-turn token.
 *   POST /sandbox/transcript  A sandbox backing up its Claude transcript to R2, same token.
 *   POST /sandbox/progress  A sandbox saying what Claude is doing (the status message), same token.
 *   queue                   Starts a turn in a sandbox (src/turn.ts).
 *
 * Plus the thread's alarm (src/thread-state.ts), which pauses quiet sandboxes.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/slack/events') return slackEvents(request, env, ctx)
    if (request.method === 'POST' && url.pathname === '/slack/interactive') return slackInteractive(request, env, ctx)
    if (request.method === 'POST' && url.pathname === '/sandbox/callback') return sandboxCallback(request, env)
    if (request.method === 'POST' && url.pathname === '/sandbox/progress') return sandboxProgress(request, env)
    if (request.method === 'POST' && url.pathname === '/sandbox/transcript') return sandboxTranscript(request, env)
    if (url.pathname === '/') return new Response('slack-agent is running. Point Slack at /slack/events.\n')
    return new Response('not found', { status: 404 })
  },

  async queue(batch: MessageBatch<TurnJob>, env: Env) {
    for (const message of batch.messages) {
      try {
        await runTurnJob(env, message.body, message.attempts, MAX_ATTEMPTS)
        message.ack()
      } catch (err) {
        console.error(`turn job failed attempt=${message.attempts}:`, err)
        message.retry({ delaySeconds: 5 * message.attempts })
      }
    }
  },
} satisfies ExportedHandler<Env, TurnJob>

/** Must match max_retries + 1 in wrangler.jsonc. */
const MAX_ATTEMPTS = 4

interface SlackEvent {
  type: string
  subtype?: string
  bot_id?: string
  user?: string
  text?: string
  ts: string
  thread_ts?: string
  channel: string
  channel_type?: string
}

async function slackEvents(request: Request, env: Env, ctx: ExecutionContext) {
  const raw = await request.text()
  const ok = await verifySlackSignature(
    env.SLACK_SIGNING_SECRET,
    raw,
    request.headers.get('x-slack-request-timestamp'),
    request.headers.get('x-slack-signature'),
  )
  if (!ok) return new Response('bad signature', { status: 401 })

  const body = JSON.parse(raw)
  if (body.type === 'url_verification') return Response.json({ challenge: body.challenge })
  if (body.type !== 'event_callback') return new Response('ok')

  const event = body.event as SlackEvent
  const botUserId: string | undefined = body.authorizations?.[0]?.user_id
  const origin = url(request)

  // Ignore bots (ourselves included), edits, deletes, joins and the like. A message with a file, or
  // a reply also sent to the channel, is still a message from a person. (The bot reads its text;
  // it does not download the file.)
  const personSubtypes = new Set(['file_share', 'thread_broadcast'])
  if (event.bot_id || !event.user || event.user === botUserId) return new Response('ok')
  if (event.subtype && !personSubtypes.has(event.subtype)) return new Response('ok')
  if (event.type !== 'app_mention' && event.type !== 'message') return new Response('ok')

  const isDm = event.channel_type === 'im'
  const mention = isDm || event.type === 'app_mention' || Boolean(botUserId && event.text?.includes(`<@${botUserId}>`))
  // A top-level channel message with no mention is not for us; skip it before touching any state.
  if (!mention && !event.thread_ts) return new Response('ok')

  // In a DM every message is its own thread unless the user replies in one.
  const threadTs = event.thread_ts ?? event.ts
  const msg = { ts: event.ts, user: event.user, text: stripMention(event.text ?? '', botUserId) }

  const thread = threadStub(env, event.channel, threadTs)

  const command = parseModelCommand(msg.text)
  if (command) {
    const reply = await thread.modelCommand(event.channel, threadTs, origin, msg, command, mention)
    if (reply.action === 'reply') {
      ctx.waitUntil(postInThread(env, event.channel, threadTs, reply.text).catch((err) => console.error('could not post the model reply:', err)))
    }
    return new Response('ok')
  }

  const result = await thread.accept(event.channel, threadTs, origin, msg, mention)
  if (result.action === 'start') {
    try {
      await env.TURNS.send({ channel: event.channel, threadTs, origin, turn: result.turn })
    } catch (err) {
      // Undo the start and answer 500, so Slack's retry of this event runs it instead of being
      // dropped as a duplicate while the thread waits for a job that was never queued.
      console.error('could not queue the turn:', err)
      await thread.abortStart(result.turn)
      return new Response('queue unavailable', { status: 500 })
    }
  } else if (result.action === 'queued') {
    // Seen, and it joins the next turn once the current one finishes.
    ctx.waitUntil(react(env, event.channel, event.ts, QUEUED_EMOJI))
  }
  return new Response('ok')
}

async function sandboxCallback(request: Request, env: Env) {
  const body = (await request.json().catch(() => null)) as {
    turnId?: string
    ok?: boolean
    text?: string
    error?: string
    costUsd?: number
    stopped?: boolean
  } | null
  if (!body?.turnId) return Response.json({ ok: false, error: 'missing turnId' }, { status: 400 })

  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  const verified = await verifyCallbackToken(env.CALLBACK_SECRET, token, body.turnId)
  if (!verified.ok) return Response.json({ ok: false, error: verified.reason }, { status: 401 })

  const { channel, threadTs, turnId, lastTs } = verified.claims
  // Claim the turn FIRST, in one call. Only the first callback for a turn gets past this, so a
  // retry can never post the answer twice. The cost: if Slack refuses the post below, the answer
  // is lost rather than retried, and the thread is told so.
  const claim = await threadStub(env, channel, threadTs).finish(turnId)
  if (!claim.accepted) return Response.json({ ok: true, duplicate: true })

  const stopped = !body.ok && body.stopped === true
  const text = body.ok
    ? body.text?.trim() || '_(no reply text)_'
    : stopped
      ? `:octagonal_sign: Stopped${claim.stoppedBy ? ` by <@${claim.stoppedBy}>` : ''}. Send a message to carry on.`
      : `:x: The run failed: ${body.error ?? 'unknown error'}`
  try {
    await postInThread(env, channel, threadTs, text)
  } catch (err) {
    console.error(`turn ${turnId}: could not post the answer:`, err)
    await postInThread(env, channel, threadTs, ':warning: I finished, but Slack refused my answer. Ask me to send it again.').catch(() => {})
  }
  // AFTER the answer, never before: deleting first would show a finished turn with no answer.
  if (claim.statusTs) await deleteMessage(env, channel, claim.statusTs)
  await react(env, channel, lastTs, body.ok ? DONE_EMOJI : stopped ? STOPPED_EMOJI : FAILED_EMOJI, WORKING_EMOJI)
  console.log(`turn ${turnId} delivered ok=${body.ok} cost=${body.costUsd ?? '?'}`)
  return Response.json({ ok: true })
}

/**
 * A progress report from the sandbox: edits the turn's status message, and answers whether to stop.
 * The thread, the status message and the clock come from the token and the thread's own records;
 * the body only says what Claude is doing, and src/status.ts caps and escapes that.
 */
async function sandboxProgress(request: Request, env: Env) {
  const body = (await request.json().catch(() => null)) as { turnId?: string; activity?: unknown; steps?: unknown } | null
  if (!body?.turnId) return Response.json({ ok: false, error: 'missing turnId' }, { status: 400 })

  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  const verified = await verifyCallbackToken(env.CALLBACK_SECRET, token, body.turnId)
  if (!verified.ok) return Response.json({ ok: false, error: verified.reason }, { status: 401 })

  const { channel, threadTs, turnId } = verified.claims
  const view = await threadStub(env, channel, threadTs).progress(turnId)
  // The thread is done with this turn (finished, or given up on): nothing to show, so stop.
  if (!view.running) return Response.json({ ok: true, stop: true })
  // Stopping: leave the "Stopping…" line alone and tell the sandbox.
  if (view.stop) return Response.json({ ok: true, stop: true })

  if (view.statusTs && body.activity !== undefined) {
    const line = statusLine({
      activity: body.activity as string,
      steps: typeof body.steps === 'number' ? body.steps : undefined,
      elapsedMs: Date.now() - view.startedAt,
    })
    await updateMessage(env, {
      channel,
      ts: view.statusTs,
      text: 'Working…',
      blocks: statusBlocks({ line, followUrl: followUrl(new URL(request.url).origin, channel, threadTs), turnId }),
    }).catch((err) => console.warn(`turn ${turnId}: could not update the status:`, err.message))
  }
  return Response.json({ ok: true, stop: false })
}

/**
 * Slack's interactivity requests (button clicks), form-encoded with the JSON in `payload`. The one
 * button is Stop (src/status.ts). It marks the turn (src/thread.ts rule 6) and the sandbox ends it
 * on its next progress report. Anyone who can see the thread can press it, as anyone can talk to
 * the bot.
 */
async function slackInteractive(request: Request, env: Env, ctx: ExecutionContext) {
  const raw = await request.text()
  const ok = await verifySlackSignature(
    env.SLACK_SIGNING_SECRET,
    raw,
    request.headers.get('x-slack-request-timestamp'),
    request.headers.get('x-slack-signature'),
  )
  if (!ok) return new Response('bad signature', { status: 401 })

  let payload: unknown = null
  try {
    payload = JSON.parse(new URLSearchParams(raw).get('payload') ?? 'null')
  } catch {
    return new Response('bad payload', { status: 400 })
  }
  const click = parseStopClick(payload)
  if (!click) return new Response('')

  const result = await threadStub(env, click.channel, click.threadTs).requestStop(click.turnId, click.user)
  if (result.action === 'stopping') {
    // Drops the button in the same edit (chat.update keeps only the blocks it is sent).
    const line = `:octagonal_sign: Stopping… (asked by <@${click.user}>)`
    ctx.waitUntil(
      updateMessage(env, {
        channel: click.channel,
        ts: click.messageTs,
        text: 'Stopping…',
        blocks: statusBlocks({ line, followUrl: followUrl(url(request), click.channel, click.threadTs), turnId: null }),
      }).catch((err) => console.warn('could not show Stopping…:', err.message)),
    )
  } else if (result.action === 'not-running' && click.responseUrl) {
    ctx.waitUntil(
      fetch(click.responseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text: 'That run has already finished.' }),
      }).catch(() => {}),
    )
  }
  return new Response('')
}

/**
 * Stores one turn's transcript in R2. The body is the gzipped JSONL; the key comes from the
 * token's claims only (src/transcripts.ts), so a sandbox can write its own thread's backups and
 * nothing else. Each turn writes its own object, and nothing here can delete one.
 */
async function sandboxTranscript(request: Request, env: Env) {
  const turnId = request.headers.get('x-turn-id') ?? ''
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  const verified = await verifyCallbackToken(env.CALLBACK_SECRET, token, turnId)
  if (!verified.ok) return Response.json({ ok: false, error: verified.reason }, { status: 401 })

  const refused = checkTranscriptSize(request.headers.get('content-length'))
  if (refused) return Response.json({ ok: false, error: refused.error }, { status: refused.status })

  const { claims } = verified
  const key = transcriptKey(claims)
  const body = await request.arrayBuffer()
  await env.TRANSCRIPTS.put(key, body, {
    httpMetadata: { contentType: 'application/x-ndjson', contentEncoding: 'gzip' },
    customMetadata: { channel: claims.channel, threadTs: claims.threadTs, turnId: claims.turnId },
  })
  // The bytes are safe in R2 now. A failed index row costs the page a listing, not the backup.
  await recordTranscript(env, {
    key,
    channel: claims.channel,
    thread_ts: claims.threadTs,
    turn_id: claims.turnId,
    bytes: body.byteLength,
    created_at: Date.now(),
  }).catch((err) => console.error(`turn ${claims.turnId}: could not index the transcript:`, err))
  console.log(`turn ${claims.turnId} transcript stored ${key} (${body.byteLength} bytes)`)
  return Response.json({ ok: true, key })
}

function stripMention(text: string, botUserId?: string) {
  return botUserId ? text.replaceAll(`<@${botUserId}>`, '').trim() : text.trim()
}

function url(request: Request) {
  return new URL(request.url).origin
}
