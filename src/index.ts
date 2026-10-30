import { verifyCallbackToken } from './callback-token.ts'
import { channelSettings } from './channel-store.ts'
import { startsWatchedThread } from './channels.ts'
import { recordTranscript } from './db.ts'
import type { Env } from './env.ts'
import { canvasLinkText, checkCanvas, checkUpload, downloadHeaders, filesFromEvent, fileSharedIn, hostedOutsideSlack, looksLikeSignInPage, MAX_FILE_BYTES, verifyFileGrant } from './files.ts'
import { checkPush, MAX_TOTAL_BYTES } from './memory.ts'
import { pullMemory, pushMemory } from './memory-store.ts'
import { parseModelCommand } from './models.ts'
import { checkSearch, normalise, publicOnly, resultsOf, searchArgs, searchErrorHint } from './search.ts'
import { channelInfo, createCanvas, deleteMessage, fileInfo, postInThread, postMessage, react, slackApi, updateMessage, uploadToThread, verifySlackSignature } from './slack.ts'
import { followUrl, parseStopClick, statusBlocks, statusLine } from './status.ts'
import { threadStub } from './thread-state.ts'
import { checkTranscriptSize, transcriptKey } from './transcripts.ts'
import { DONE_EMOJI, FAILED_EMOJI, MIDTURN_EMOJI, QUEUED_EMOJI, runTurnJob, STOPPED_EMOJI, WORKING_EMOJI, type TurnJob } from './turn.ts'

export { ThreadState } from './thread-state.ts'

/**
 * The ways in:
 *
 *   POST /slack/events      Slack's Events API. Answers within Slack's 3 seconds and queues the work.
 *   POST /slack/interactive Slack's button clicks: the Stop button on a running turn.
 *   POST /sandbox/callback  A sandbox delivering one turn's answer, with its one-turn token.
 *   POST /sandbox/transcript  A sandbox backing up its Claude transcript to R2, same token.
 *   POST /sandbox/progress  A sandbox saying what Claude is doing (the status message), same token.
 *                           The answer says whether to stop, and hands over follow-ups sent mid-turn.
 *   GET  /sandbox/memory    A sandbox pulling its CHANNEL's memory notes before a turn, same token.
 *   POST /sandbox/memory    A sandbox pushing what Claude changed in those notes after a turn.
 *   GET  /sandbox/file      A sandbox fetching one file sent in its thread, with that file's grant.
 *   POST /sandbox/upload    Claude posting a file into its own thread, with the turn's tools token.
 *   POST /sandbox/canvas    Claude posting a canvas into its own thread, same tools token.
 *   POST /sandbox/search    Claude searching the workspace's PUBLIC channels, same tools token.
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
    if (request.method === 'GET' && url.pathname === '/sandbox/memory') return sandboxMemoryPull(request, env)
    if (request.method === 'POST' && url.pathname === '/sandbox/memory') return sandboxMemoryPush(request, env)
    if (request.method === 'GET' && url.pathname === '/sandbox/file') return sandboxFile(request, env)
    if (request.method === 'POST' && url.pathname === '/sandbox/upload') return sandboxUpload(request, env)
    if (request.method === 'POST' && url.pathname === '/sandbox/canvas') return sandboxCanvas(request, env)
    if (request.method === 'POST' && url.pathname === '/sandbox/search') return sandboxSearch(request, env)
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
  files?: unknown[]
  /** Slack's search permission, on an @mention or a DM (src/search.ts). */
  action_token?: string
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
  // a reply also sent to the channel, is still a message from a person. Its files reach Claude when
  // its turn starts (src/files.ts).
  const personSubtypes = new Set(['file_share', 'thread_broadcast'])
  if (event.bot_id || !event.user || event.user === botUserId) return new Response('ok')
  if (event.subtype && !personSubtypes.has(event.subtype)) return new Response('ok')
  if (event.type !== 'app_mention' && event.type !== 'message') return new Response('ok')

  const isDm = event.channel_type === 'im'
  const mentioned = isDm || event.type === 'app_mention' || Boolean(botUserId && event.text?.includes(`<@${botUserId}>`))
  // Watched channels and the channel's default model (src/channels.ts). If D1 cannot answer, the
  // message is handled as if the channel had no settings, and the thread keeps the model it had.
  const settings = await channelSettings(env, event.channel).catch((err) => {
    console.warn(`could not read the settings of ${event.channel}:`, (err as Error).message)
    return null
  })
  // In a watched channel a root message starts a thread as a mention would.
  const mention = mentioned || startsWatchedThread({ threadTs: event.thread_ts, isDm }, settings ?? { watched: false })
  const channelModel = settings ? settings.model : undefined
  // A top-level channel message with no mention is not for us; skip it before touching any state.
  if (!mention && !event.thread_ts) return new Response('ok')

  // In a DM every message is its own thread unless the user replies in one.
  const threadTs = event.thread_ts ?? event.ts
  const files = filesFromEvent(event.files)
  const hasFiles = files.length > 0 || event.subtype === 'file_share'
  const msg = {
    ts: event.ts,
    user: event.user,
    text: stripMention(event.text ?? '', botUserId),
    ...(hasFiles ? { hasFiles } : {}),
    ...(files.length ? { files } : {}),
    ...(typeof event.action_token === 'string' && event.action_token ? { actionToken: event.action_token } : {}),
  }

  const thread = threadStub(env, event.channel, threadTs)

  const command = parseModelCommand(msg.text)
  if (command) {
    const reply = await thread.modelCommand(event.channel, threadTs, origin, msg, command, mention, channelModel)
    if (reply.action === 'reply') {
      ctx.waitUntil(postInThread(env, event.channel, threadTs, reply.text).catch((err) => console.error('could not post the model reply:', err)))
    }
    return new Response('ok')
  }

  const result = await thread.accept(event.channel, threadTs, origin, msg, mention, channelModel)
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
  } else if (result.action === 'midturn') {
    // Handed to the running turn: Claude reads it at its next tool step and covers it in the same
    // reply (src/thread.ts rule 7). If it does not, it runs as the next turn.
    ctx.waitUntil(react(env, event.channel, event.ts, MIDTURN_EMOJI))
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
    taken?: unknown
  } | null
  if (!body?.turnId) return Response.json({ ok: false, error: 'missing turnId' }, { status: 400 })

  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  const verified = await verifyCallbackToken(env.CALLBACK_SECRET, token, body.turnId)
  if (!verified.ok) return Response.json({ ok: false, error: verified.reason }, { status: 401 })

  const { channel, threadTs, turnId, lastTs } = verified.claims
  // Claim the turn FIRST, in one call. Only the first callback for a turn gets past this, so a
  // retry can never post the answer twice. The cost: if Slack refuses the post below, the answer
  // is lost rather than retried, and the thread is told so.
  // `taken` only says which follow-ups Claude read; the thread counts only ones it handed this turn.
  const taken = Array.isArray(body.taken) ? body.taken.filter((t): t is string => typeof t === 'string').slice(0, 200) : []
  const claim = await threadStub(env, channel, threadTs).finish(turnId, { answered: body.ok === true, taken })
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
  // Follow-ups this answer covered get no reply of their own, just the tick.
  await Promise.all(claim.folded.map((m) => react(env, channel, m.ts, DONE_EMOJI, MIDTURN_EMOJI)))
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
  // Follow-ups for this turn (rule 7 in src/thread.ts). They come from this thread's own records,
  // so a sandbox only ever sees messages from its own thread.
  const messages = view.inbox.map(({ ts, user, text }) => ({ ts, user, text }))

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
  return Response.json({ ok: true, stop: false, messages })
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
 * One file from the thread, for the runner (box/files.mjs). The grant names the file, channel and
 * thread (src/files.ts); Slack is asked whether the file is still in that channel before a byte
 * moves. The bytes stream through and are never held here.
 */
async function sandboxFile(request: Request, env: Env) {
  const grant = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  const verified = await verifyFileGrant(env.CALLBACK_SECRET, grant)
  if (!verified.ok) return Response.json({ ok: false, error: verified.reason }, { status: 401 })
  const { channel, fileId } = verified.claims

  let file: Record<string, unknown> | null
  try {
    file = await fileInfo(env, fileId)
  } catch (err) {
    // missing_scope here means the app was not reinstalled after files:read was added.
    return Response.json({ ok: false, error: (err as Error).message }, { status: 502 })
  }
  if (!file || !fileSharedIn(file, channel)) return Response.json({ ok: false, error: 'file is not in this channel' }, { status: 403 })
  if (hostedOutsideSlack(file)) return Response.json({ ok: false, error: 'hosted outside Slack' }, { status: 422 })
  if (typeof file.size === 'number' && file.size > MAX_FILE_BYTES) return Response.json({ ok: false, error: 'too large' }, { status: 413 })
  const source = (file.url_private_download ?? file.url_private) as string | undefined
  if (!source) return Response.json({ ok: false, error: 'Slack gave no download link' }, { status: 502 })

  const upstream = await fetch(source, { headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } })
  if (!upstream.ok || !upstream.body) return Response.json({ ok: false, error: `Slack answered ${upstream.status}` }, { status: 502 })
  if (looksLikeSignInPage(upstream.headers, file)) {
    await upstream.body.cancel()
    return Response.json({ ok: false, error: 'Slack sent its sign-in page: reinstall the app so the token has files:read' }, { status: 502 })
  }
  return new Response(upstream.body, { headers: downloadHeaders(upstream.headers, file) })
}

/**
 * A file from Claude (box/tools.mjs upload), posted into its own thread. Checked before the body is
 * read; the channel and thread come from the token only.
 */
async function sandboxUpload(request: Request, env: Env) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  const verified = await verifyCallbackToken(env.CALLBACK_SECRET, token, request.headers.get('x-turn-id') ?? '', Date.now(), 'tools')
  if (!verified.ok) return Response.json({ ok: false, error: verified.reason }, { status: 401 })

  const checked = checkUpload({
    contentLength: request.headers.get('content-length'),
    filename: request.headers.get('x-filename'),
    title: request.headers.get('x-title'),
    comment: request.headers.get('x-comment'),
  })
  if (!checked.ok) return Response.json({ ok: false, error: checked.error }, { status: checked.status })

  const { channel, threadTs, turnId } = verified.claims
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength !== checked.size) return Response.json({ ok: false, error: 'body does not match content-length' }, { status: 400 })
  try {
    const permalink = await uploadToThread(env, { channel, threadTs, bytes, ...checked.upload })
    console.log(`turn ${turnId} posted a file (${bytes.byteLength} bytes)`)
    return Response.json({ ok: true, permalink })
  } catch (err) {
    console.error(`turn ${turnId}: upload failed:`, err)
    return Response.json({ ok: false, error: (err as Error).message }, { status: 502 })
  }
}

/** A canvas from Claude (box/tools.mjs canvas): made, shared with the channel, linked in the thread. */
async function sandboxCanvas(request: Request, env: Env) {
  const body = (await request.json().catch(() => null)) as { turnId?: string } | null
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  const verified = await verifyCallbackToken(env.CALLBACK_SECRET, token, body?.turnId ?? '', Date.now(), 'tools')
  if (!verified.ok) return Response.json({ ok: false, error: verified.reason }, { status: 401 })

  const checked = checkCanvas(body)
  if (!checked.ok) return Response.json({ ok: false, error: checked.error }, { status: 400 })

  const { channel, threadTs, turnId } = verified.claims
  try {
    const { permalink } = await createCanvas(env, { channel, title: checked.title, markdown: checked.markdown })
    // Already Slack mrkdwn (a <link|title>), so it skips the Markdown conversion postInThread does.
    await postMessage(env, { channel, thread_ts: threadTs, text: canvasLinkText(checked.title, permalink) })
    console.log(`turn ${turnId} made a canvas`)
    return Response.json({ ok: true, permalink })
  } catch (err) {
    console.error(`turn ${turnId}: canvas failed:`, err)
    return Response.json({ ok: false, error: (err as Error).message }, { status: 502 })
  }
}

/**
 * Workspace search for Claude (box/tools.mjs search), PUBLIC CHANNELS ONLY (src/search.ts). The
 * token says which thread and turn; Slack's search permission comes from that thread's own records,
 * and every result is checked to be from a public channel before it leaves.
 */
async function sandboxSearch(request: Request, env: Env) {
  const body = (await request.json().catch(() => null)) as { turnId?: string } | null
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  const verified = await verifyCallbackToken(env.CALLBACK_SECRET, token, body?.turnId ?? '', Date.now(), 'tools')
  if (!verified.ok) return Response.json({ ok: false, error: verified.reason }, { status: 401 })

  const checked = checkSearch(body)
  if (!checked.ok) return Response.json({ ok: false, error: checked.error }, { status: 400 })

  const { channel, threadTs, turnId } = verified.claims
  const view = await threadStub(env, channel, threadTs).searchView(turnId)
  if (!view.running) return Response.json({ ok: false, error: 'this turn is over' }, { status: 409 })

  let json: Record<string, unknown>
  try {
    json = await slackApi(env, 'assistant.search.context', searchArgs(checked.query, checked.limit, view.actionToken))
  } catch (err) {
    const error = searchErrorHint((err as Error).message, Boolean(view.actionToken))
    console.warn(`turn ${turnId}: search refused: ${error}`)
    return Response.json({ ok: false, error }, { status: 502 })
  }
  const { hits, dropped } = await publicOnly(resultsOf(json).map(normalise), (id) => channelInfo(env, id))
  if (dropped) console.warn(`turn ${turnId}: search dropped ${dropped} result(s) not from a public channel`)
  return Response.json({ ok: true, results: hits })
}

/**
 * The channel's memory notes, for the runner (box/memory.mjs). The folder comes from the token's
 * channel only (src/memory.ts), so a sandbox reads its own channel's notes and no one else's.
 */
async function sandboxMemoryPull(request: Request, env: Env) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  const verified = await verifyCallbackToken(env.CALLBACK_SECRET, token, request.headers.get('x-turn-id') ?? '')
  if (!verified.ok) return Response.json({ ok: false, error: verified.reason }, { status: 401 })
  const { channel, turnId } = verified.claims
  try {
    const files = await pullMemory(env, channel)
    return Response.json({ ok: true, files: files.map(({ path, content }) => ({ path, content })) })
  } catch (err) {
    console.error(`turn ${turnId}: memory pull failed:`, err)
    return Response.json({ ok: false, error: (err as Error).message }, { status: 502 })
  }
}

/** What Claude changed in its notes, committed to the token's channel folder (src/memory-store.ts). */
async function sandboxMemoryPush(request: Request, env: Env) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  const verified = await verifyCallbackToken(env.CALLBACK_SECRET, token, request.headers.get('x-turn-id') ?? '')
  if (!verified.ok) return Response.json({ ok: false, error: verified.reason }, { status: 401 })
  // JSON escaping can double the text, plus paths and shas; anything past that is not memory.
  if (Number(request.headers.get('content-length') ?? 0) > 3 * MAX_TOTAL_BYTES) {
    return Response.json({ ok: false, error: 'too large' }, { status: 413 })
  }
  const checked = checkPush(await request.json().catch(() => null))
  if (!checked.ok) return Response.json({ ok: false, error: checked.error }, { status: 400 })

  const { channel, threadTs, turnId } = verified.claims
  try {
    const commit = await pushMemory(env, { channel, threadTs, turnId }, checked.push)
    console.log(`turn ${turnId}: memory ${commit ? `committed ${commit}` : 'unchanged'}`)
    return Response.json({ ok: true, commit })
  } catch (err) {
    console.error(`turn ${turnId}: memory push failed:`, err)
    return Response.json({ ok: false, error: (err as Error).message }, { status: 502 })
  }
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
