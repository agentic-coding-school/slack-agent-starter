/**
 * The rules for one Slack thread, as plain functions over plain data so they can be tested
 * without Cloudflare. src/thread-state.ts stores the data and calls these.
 *
 * Four rules hold here:
 *
 * 1. ONE TURN AT A TIME. Two `claude --resume` runs on one session write into the same transcript
 *    and break it for good. A message that arrives while a turn runs waits in `pending`, and the
 *    next turn takes every waiting message at once.
 * 2. EACH SLACK MESSAGE RUNS ONCE. Slack sends a mention twice (as `app_mention` and as `message`)
 *    and retries anything we answer slowly, so messages are deduped by their `ts`.
 * 3. A THREAD STARTS WITH A MENTION. After that, every reply in the thread goes to the bot, with or
 *    without a mention.
 * 4. NO TURN STARTS WHILE THE SANDBOX IS BEING PAUSED. A pause request that lands after a turn
 *    started would freeze that turn mid-run, so messages wait until the pause is done.
 */

export interface SlackMessage {
  ts: string
  user: string
  text: string
}

export interface Turn {
  turnId: string
  messages: SlackMessage[]
  /** True for the first turn in a thread: the prompt then includes the earlier thread messages. */
  firstTurn: boolean
  /** When the thread started this turn. The turn's time limit counts from here, everywhere. */
  startedAt: number
}

export interface ThreadData {
  channel: string
  threadTs: string
  /** The Worker's own address, so a sandbox started from a queue job knows where to report back. */
  origin: string
  known: boolean
  seen: string[]
  running: { turnId: string; startedAt: number } | null
  pending: SlackMessage[]
  lastActivityAt: number
  /** Set once the idle pause has been sent, so the alarm does not send it twice. */
  parked: boolean
  /** Set while a pause call is in flight (rule 4). */
  pausing: boolean
}

/** How many message ids to remember for dedupe. Slack retries within minutes, not days. */
const SEEN_LIMIT = 200

/** Time for a finished turn's reply to reach us before the turn counts as lost. */
export const LOST_TURN_MARGIN_MS = 5 * 60_000

type Clock = { now: number; newTurnId: () => string }

export function emptyThread(channel: string, threadTs: string, origin: string): ThreadData {
  return {
    channel,
    threadTs,
    origin,
    known: false,
    seen: [],
    running: null,
    pending: [],
    lastActivityAt: 0,
    parked: true,
    pausing: false,
  }
}

export type AcceptResult =
  | { action: 'skip'; reason: string }
  | { action: 'queued' }
  | { action: 'start'; turn: Turn }

export function accept(data: ThreadData, msg: SlackMessage, opts: Clock & { mention: boolean }): AcceptResult {
  if (!data.known && !opts.mention) return { action: 'skip', reason: 'not-our-thread' }
  if (data.seen.includes(msg.ts)) return { action: 'skip', reason: 'duplicate' }

  data.seen.push(msg.ts)
  if (data.seen.length > SEEN_LIMIT) data.seen.splice(0, data.seen.length - SEEN_LIMIT)
  data.lastActivityAt = opts.now
  const firstTurn = !data.known
  data.known = true

  if (data.running || data.pausing) {
    data.pending.push(msg)
    return { action: 'queued' }
  }
  return { action: 'start', turn: begin(data, [msg], firstTurn, opts) }
}

/**
 * The job for a turn could not be queued. Undo the start so Slack's retry of the same event is
 * not dropped as a duplicate.
 */
export function abortStart(data: ThreadData, turn: Turn) {
  if (data.running?.turnId !== turn.turnId) return
  data.running = null
  const ids = new Set(turn.messages.map((m) => m.ts))
  data.seen = data.seen.filter((ts) => !ids.has(ts))
  if (turn.firstTurn) data.known = false
}

/**
 * The next turn's job could not be queued. Put its messages back; the alarm tries again.
 */
export function requeue(data: ThreadData, turn: Turn) {
  if (data.running?.turnId !== turn.turnId) return
  data.running = null
  data.pending.unshift(...turn.messages)
}

export type FinishResult = { accepted: false } | { accepted: true; next: Turn | null }

/** The turn is over (answer delivered or start failed). Returns the next turn if messages waited. */
export function finish(data: ThreadData, turnId: string, opts: Clock): FinishResult {
  if (data.running?.turnId !== turnId) return { accepted: false }
  data.running = null
  data.lastActivityAt = opts.now
  return { accepted: true, next: takePending(data, opts) }
}

export type AlarmResult =
  | { action: 'none' }
  | { action: 'wait'; until: number }
  | { action: 'pause' }
  | { action: 'start'; next: Turn }
  | { action: 'stale'; lostTurnId: string; next: Turn | null }

/**
 * What the thread's alarm should do now.
 *
 * - A turn that ran past its limit (plus a margin for the reply to arrive) is treated as lost: its
 *   sandbox died or its callback never came. The thread is freed so it does not stay stuck forever.
 * - Messages waiting with no turn running (a queue send failed) start a turn.
 * - A quiet thread whose sandbox is still awake is paused.
 */
export function onAlarm(data: ThreadData, opts: Clock & { maxTurnMs: number; idlePauseMs: number }): AlarmResult {
  if (data.running) {
    const deadline = data.running.startedAt + opts.maxTurnMs + LOST_TURN_MARGIN_MS
    if (opts.now < deadline) return { action: 'wait', until: deadline }
    const lostTurnId = data.running.turnId
    data.running = null
    data.lastActivityAt = opts.now
    return { action: 'stale', lostTurnId, next: takePending(data, opts) }
  }
  if (data.pausing) return { action: 'none' }
  const next = takePending(data, opts)
  if (next) return { action: 'start', next }
  if (data.parked) return { action: 'none' }
  const quietAt = data.lastActivityAt + opts.idlePauseMs
  if (opts.now < quietAt) return { action: 'wait', until: quietAt }
  data.pausing = true
  return { action: 'pause' }
}

/** The pause call returned. Starts the turn for any messages that arrived while it ran. */
export function afterPause(data: ThreadData, opts: Clock & { paused: boolean }): Turn | null {
  data.pausing = false
  if (opts.paused && !data.pending.length) data.parked = true
  return takePending(data, opts)
}

function takePending(data: ThreadData, opts: Clock): Turn | null {
  if (!data.pending.length) return null
  const messages = data.pending.splice(0)
  return begin(data, messages, false, opts)
}

function begin(data: ThreadData, messages: SlackMessage[], firstTurn: boolean, opts: Clock): Turn {
  const turnId = opts.newTurnId()
  data.running = { turnId, startedAt: opts.now }
  data.parked = false
  return { turnId, messages, firstTurn, startedAt: opts.now }
}
