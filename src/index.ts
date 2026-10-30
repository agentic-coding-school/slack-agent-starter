import { verifyCallbackToken } from './callback-token.ts'
import type { Env } from './env.ts'
import { postInThread, react, verifySlackSignature } from './slack.ts'
import { threadStub } from './thread-state.ts'
import { DONE_EMOJI, FAILED_EMOJI, QUEUED_EMOJI, runTurnJob, WORKING_EMOJI, type TurnJob } from './turn.ts'

export { ThreadState } from './thread-state.ts'

/**
 * Three ways in:
 *
 *   POST /slack/events      Slack's Events API. Answers within Slack's 3 seconds and queues the work.
 *   POST /sandbox/callback  A sandbox delivering one turn's answer, with its one-turn token.
 *   queue                   Starts a turn in a sandbox (src/turn.ts).
 *
 * Plus the thread's alarm (src/thread-state.ts), which pauses quiet sandboxes.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/slack/events') return slackEvents(request, env, ctx)
    if (request.method === 'POST' && url.pathname === '/sandbox/callback') return sandboxCallback(request, env)
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

  const text = body.ok ? body.text?.trim() || '_(no reply text)_' : `:x: The run failed: ${body.error ?? 'unknown error'}`
  try {
    await postInThread(env, channel, threadTs, text)
  } catch (err) {
    console.error(`turn ${turnId}: could not post the answer:`, err)
    await postInThread(env, channel, threadTs, ':warning: I finished, but Slack refused my answer. Ask me to send it again.').catch(() => {})
  }
  await react(env, channel, lastTs, body.ok ? DONE_EMOJI : FAILED_EMOJI, WORKING_EMOJI)
  console.log(`turn ${turnId} delivered ok=${body.ok} cost=${body.costUsd ?? '?'}`)
  return Response.json({ ok: true })
}

function stripMention(text: string, botUserId?: string) {
  return botUserId ? text.replaceAll(`<@${botUserId}>`, '').trim() : text.trim()
}

function url(request: Request) {
  return new URL(request.url).origin
}
