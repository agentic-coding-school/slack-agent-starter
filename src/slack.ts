import { timingSafeEqual } from './callback-token.ts'
import type { Env } from './env.ts'
import { toMrkdwn } from './mrkdwn.js'

/** Slack refuses a message over 40,000 characters and folds long ones badly; split well below. */
const CHUNK_CHARS = 3800

/** Requests older than this are refused, so a captured request cannot be replayed later. */
const MAX_SKEW_SECONDS = 5 * 60

/** https://api.slack.com/authentication/verifying-requests-from-slack */
export async function verifySlackSignature(
  signingSecret: string,
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!timestamp || !signature?.startsWith('v0=')) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return false

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${timestamp}:${rawBody}`)))
  const expected = new TextEncoder().encode('v0=' + [...mac].map((b) => b.toString(16).padStart(2, '0')).join(''))
  return timingSafeEqual(expected, new TextEncoder().encode(signature))
}

/** Slack's read methods take only form-encoded arguments; a JSON body reaches them empty. */
const FORM_METHODS = new Set(['conversations.replies', 'conversations.history', 'users.info'])

export async function slackApi(env: Env, method: string, args: Record<string, unknown>) {
  const form = FORM_METHODS.has(method)
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8',
    },
    body: form
      ? new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)]))
      : JSON.stringify(args),
  })
  const json = (await res.json()) as { ok: boolean; error?: string; [key: string]: unknown }
  if (!json.ok) throw new Error(`slack ${method}: ${json.error ?? res.status}`)
  return json
}

/** Posts Markdown into a thread as Slack mrkdwn, split into several messages when it is long. */
export async function postInThread(env: Env, channel: string, threadTs: string, markdown: string) {
  for (const text of splitMessage(toMrkdwn(markdown))) {
    await slackApi(env, 'chat.postMessage', { channel, thread_ts: threadTs, text, unfurl_links: false })
  }
}

/** Splits on paragraph, then line, boundaries so code blocks and lists break as rarely as possible. */
export function splitMessage(text: string, max = CHUNK_CHARS): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const chunks: string[] = []
  let rest = trimmed
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max)
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max)
    if (cut < max / 2) cut = max
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) chunks.push(rest)
  return chunks
}

/** Reactions are a status light, never worth failing a turn over. */
export async function react(env: Env, channel: string, ts: string, add: string | null, remove: string | null = null) {
  const calls: Promise<unknown>[] = []
  if (remove) calls.push(slackApi(env, 'reactions.remove', { channel, timestamp: ts, name: remove }))
  if (add) calls.push(slackApi(env, 'reactions.add', { channel, timestamp: ts, name: add }))
  await Promise.allSettled(calls)
}

/** The thread's messages before `beforeTs`, oldest first, for the first turn's prompt. */
export async function threadHistory(env: Env, channel: string, threadTs: string, beforeTs: string, limit = 30) {
  const json = await slackApi(env, 'conversations.replies', { channel, ts: threadTs, limit: 200 }).catch((err) => {
    console.warn('could not read thread history:', err.message)
    return { messages: [] }
  })
  const messages = (json.messages as Array<{ ts: string; user?: string; bot_id?: string; text?: string }>) ?? []
  return messages
    .filter((m) => Number(m.ts) < Number(beforeTs) && m.text)
    .slice(-limit)
    .map((m) => ({ ts: m.ts, user: m.user ?? (m.bot_id ? 'a bot' : 'unknown'), text: m.text ?? '' }))
}
