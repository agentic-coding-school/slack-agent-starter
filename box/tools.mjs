#!/usr/bin/env node
// Claude's tools for its own Slack thread. Claude runs them with Bash:
//
//   node ~/.agent/tools.mjs upload <file> [--title "Title"] [--comment "A line about it"]
//   node ~/.agent/tools.mjs canvas <markdown-file> --title "Title"
//   node ~/.agent/tools.mjs search "<question or words>" [--limit 10]
//   node ~/.agent/tools.mjs routine create --cron "0 9 * * 1" [--tz Europe/London] [--model sonnet] --prompt "What to do"
//   node ~/.agent/tools.mjs routine list | pause <id> | resume <id> | delete <id>
//   node ~/.agent/tools.mjs follow-pr <PR link> | unfollow-pr <PR link>
//
// follow-pr makes GitHub wake THIS thread when the PR's CI fails or a person reviews or comments on
// it, until it is merged or closed. Only PRs this bot opened can be followed (src/pr-follow.ts).
//
// routine works on THIS channel's routines only: the Worker takes the channel from the token. Each
// run posts a new thread in the channel and starts a turn there (src/routines.ts).
//
// search reads PUBLIC channels only: the Worker asks Slack for public channels and drops anything
// else before it answers (src/search.ts).
//
// Each calls a Worker door with this turn's `tools` token (AGENT_TOOLS_TOKEN). The Worker holds the
// Slack token and picks the channel and thread from the token, so these can only post into the
// thread this sandbox belongs to. The token cannot deliver the turn's answer or stop the turn.

import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export const USAGE = [
  'Usage:',
  '  node ~/.agent/tools.mjs upload <file> [--title "Title"] [--comment "A line about it"]',
  '  node ~/.agent/tools.mjs canvas <markdown-file> --title "Title"',
  '  node ~/.agent/tools.mjs search "<question or words>" [--limit 10]',
  '  node ~/.agent/tools.mjs routine create --cron "0 9 * * 1" [--tz Europe/London] [--model sonnet] --prompt "What to do"',
  '  node ~/.agent/tools.mjs routine list',
  '  node ~/.agent/tools.mjs routine pause|resume|delete <id>',
  '  node ~/.agent/tools.mjs follow-pr <PR link>',
  '  node ~/.agent/tools.mjs unfollow-pr <PR link>',
].join('\n')

const ROUTINE_FLAGS = { '--cron': 'cron', '--tz': 'timezone', '--model': 'model', '--prompt': 'prompt' }

/** `routine <action> ...`: the Worker checks the cron, the time zone and the model. */
function parseRoutine(rest) {
  const [action, ...args] = rest
  if (!['create', 'list', 'pause', 'resume', 'delete'].includes(action)) {
    return { error: action ? `unknown routine action ${action}` : 'routine needs an action: create, list, pause, resume or delete' }
  }
  const flags = {}
  const positional = []
  for (let i = 0; i < args.length; i++) {
    const name = ROUTINE_FLAGS[args[i]]
    if (name) {
      if (i + 1 >= args.length) return { error: `${args[i]} needs a value` }
      flags[name] = args[++i]
    } else if (args[i].startsWith('--')) {
      return { error: `unknown option ${args[i]}` }
    } else {
      positional.push(args[i])
    }
  }
  if (action === 'create') {
    if (positional.length) return { error: 'routine create takes only --cron, --tz, --model and --prompt; quote each value' }
    if (!flags.cron) return { error: 'routine create needs --cron, such as "0 9 * * 1" (Mondays 9:00)' }
    if (!flags.prompt?.trim()) return { error: 'routine create needs --prompt: what to do on each run' }
    return { command: 'routine', action, ...flags }
  }
  if (Object.keys(flags).length) return { error: `routine ${action} takes no options` }
  if (action === 'list') {
    if (positional.length) return { error: 'routine list takes nothing else' }
    return { command: 'routine', action }
  }
  if (positional.length !== 1) return { error: `routine ${action} takes one routine id` }
  return { command: 'routine', action, id: positional[0] }
}

/** Reads the command line. Returns the command, or `{ error }` with what is wrong. */
export function parseArgs(argv) {
  const [command, ...rest] = argv
  if (command === 'routine') return parseRoutine(rest)
  if (command === 'follow-pr' || command === 'unfollow-pr') {
    // The Worker checks the link; here only its shape.
    if (rest.length !== 1 || rest[0].startsWith('--')) return { error: `${command} takes one PR link, such as https://github.com/owner/repo/pull/12` }
    return { command, pr: rest[0] }
  }
  const flags = {}
  const positional = []
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--title' || arg === '--comment' || arg === '--limit') {
      if (i + 1 >= rest.length) return { error: `${arg} needs a value` }
      flags[arg.slice(2)] = rest[++i]
    } else if (arg.startsWith('--')) {
      return { error: `unknown option ${arg}` }
    } else {
      positional.push(arg)
    }
  }
  if (command !== 'search' && flags.limit !== undefined) return { error: `${command ?? 'that'} takes no --limit` }
  if (command === 'search') {
    if (positional.length !== 1 || !positional[0].trim()) return { error: 'search takes one query; quote it' }
    if (flags.title || flags.comment) return { error: 'search takes only --limit' }
    if (flags.limit === undefined) return { command, query: positional[0] }
    const limit = Number(flags.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) return { error: '--limit must be a whole number from 1 to 20' }
    return { command, query: positional[0], limit }
  }
  if (command === 'upload') {
    if (positional.length !== 1) return { error: 'upload takes one file' }
    return { command, path: positional[0], title: flags.title, comment: flags.comment }
  }
  if (command === 'canvas') {
    if (positional.length !== 1) return { error: 'canvas takes one markdown file' }
    if (!flags.title) return { error: 'canvas needs --title' }
    if (flags.comment) return { error: 'canvas takes no --comment' }
    return { command, path: positional[0], title: flags.title }
  }
  return { error: command ? `unknown command ${command}` : 'no command' }
}

/** Runs one parsed command against the Worker. Returns what to print; throws with the reason. */
export async function run(cmd, { env = process.env, fetchImpl = fetch } = {}) {
  if (!env.AGENT_API_URL || !env.AGENT_TOOLS_TOKEN || !env.TURN_ID) {
    throw new Error('these tools only work inside a turn (AGENT_API_URL, AGENT_TOOLS_TOKEN and TURN_ID are not set)')
  }
  const auth = { authorization: `Bearer ${env.AGENT_TOOLS_TOKEN}`, 'x-turn-id': env.TURN_ID }

  if (cmd.command === 'upload') {
    const size = statSync(cmd.path).size
    const res = await fetchImpl(new URL('/sandbox/upload', env.AGENT_API_URL), {
      method: 'POST',
      headers: {
        ...auth,
        'content-type': 'application/octet-stream',
        'content-length': String(size),
        // Headers carry only ASCII, and a name or comment can be anything; the Worker decodes them.
        'x-filename': encodeURIComponent(basename(cmd.path)),
        ...(cmd.title ? { 'x-title': encodeURIComponent(cmd.title) } : {}),
        ...(cmd.comment ? { 'x-comment': encodeURIComponent(cmd.comment) } : {}),
      },
      body: readFileSync(cmd.path),
    })
    const out = await answer(res)
    return `Posted ${basename(cmd.path)} in the thread${out.permalink ? `: ${out.permalink}` : '.'}`
  }

  if (cmd.command === 'search') {
    const res = await fetchImpl(new URL('/sandbox/search', env.AGENT_API_URL), {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ turnId: env.TURN_ID, query: cmd.query, ...(cmd.limit ? { limit: cmd.limit } : {}) }),
    })
    const out = await answer(res)
    return formatResults(cmd.query, Array.isArray(out.results) ? out.results : [])
  }

  if (cmd.command === 'routine') {
    const { command, ...fields } = cmd
    const res = await fetchImpl(new URL('/sandbox/routines', env.AGENT_API_URL), {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ turnId: env.TURN_ID, ...fields }),
    })
    const out = await answer(res)
    if (cmd.action === 'list') return formatRoutines(Array.isArray(out.routines) ? out.routines : [])
    if (cmd.action === 'delete') return `Deleted routine ${cmd.id}. It will not run again.`
    const r = out.routine ?? {}
    if (cmd.action === 'create') {
      return [
        `Made routine ${r.id}: \`${r.cron}\` in ${r.timezone}${r.model ? `, on ${r.model}` : ''}.`,
        `Next run: ${r.nextRun ?? 'never'}. Each run posts a new thread in this channel.`,
        `Tell the person the schedule in words and the time zone, and that \`routine pause ${r.id}\` or \`routine delete ${r.id}\` stops it.`,
      ].join('\n')
    }
    return cmd.action === 'pause' ? `Paused routine ${r.id}.` : `Resumed routine ${r.id}. Next run: ${r.nextRun ?? 'never'}.`
  }

  if (cmd.command === 'follow-pr' || cmd.command === 'unfollow-pr') {
    const action = cmd.command === 'follow-pr' ? 'follow' : 'unfollow'
    const res = await fetchImpl(new URL('/sandbox/follow-pr', env.AGENT_API_URL), {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ turnId: env.TURN_ID, action, pr: cmd.pr }),
    })
    const out = await answer(res)
    if (action === 'unfollow') return `Stopped following ${cmd.pr}. GitHub will not wake this thread for it any more.`
    return [
      `Following ${cmd.pr}. A failed check, a review or a comment from a person wakes this thread (at most 3 times a day);`,
      'a merge or close ends it with a note.',
      ...(out.webhook === false ? ['WARNING: the GitHub webhook secret is not set, so nothing will arrive yet. Say so in your reply.'] : []),
    ].join(' ')
  }

  const res = await fetchImpl(new URL('/sandbox/canvas', env.AGENT_API_URL), {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ turnId: env.TURN_ID, title: cmd.title, markdown: readFileSync(cmd.path, 'utf8') }),
  })
  const out = await answer(res)
  return `Made the canvas and posted its link in the thread${out.permalink ? `: ${out.permalink}` : '.'}`
}

/** Search results as Claude reads them: where, when, who, the text, and the link to cite. */
export function formatResults(query, results) {
  if (!results.length) return `No public-channel messages found for "${query}". Private channels and DMs are never searched.`
  const lines = [`${results.length} result(s) for "${query}", from public channels only:`, '']
  for (const r of results) {
    const when = /^\d+(\.\d+)?$/.test(r.ts ?? '') ? new Date(Number(r.ts) * 1000).toISOString().replace('T', ' ').slice(0, 16) : '?'
    lines.push(`[${when}] #${r.channelName || r.channelId || '?'} <@${r.user || '?'}>`, r.text || '(no text)')
    if (r.permalink) lines.push(r.permalink)
    lines.push('')
  }
  // Every field blank is what a change in Slack's answer looks like, not what "found it" looks like.
  if (results.every((r) => !r.text && !r.ts)) lines.push('WARNING: every result came back empty. Say so rather than treat it as an answer.')
  return lines.join('\n').trimEnd()
}

/** A channel's routines as Claude reads them. */
export function formatRoutines(routines) {
  if (!routines.length) return 'This channel has no routines.'
  const lines = [`${routines.length} routine(s) in this channel:`, '']
  for (const r of routines) {
    const by = r.createdBy ? ` by <@${r.createdBy}>` : ''
    const when = r.status === 'paused' ? 'paused' : `next ${r.nextRun ?? 'never'}`
    lines.push(`${r.id} · \`${r.cron}\` ${r.timezone}${r.model ? ` · ${r.model}` : ''} · ${when}${by}`)
    const prompt = String(r.prompt ?? '')
    lines.push(`  ${prompt.length > 200 ? `${prompt.slice(0, 200)}…` : prompt}`, '')
  }
  return lines.join('\n').trimEnd()
}

async function answer(res) {
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.ok) throw new Error(`the Worker refused: ${body.error ?? res.status}`)
  return body
}

// Run only when started as a program, so the tests can import the functions above.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cmd = parseArgs(process.argv.slice(2))
  if (cmd.error) {
    console.error(`${cmd.error}\n\n${USAGE}`)
    process.exit(2)
  }
  try {
    console.log(await run(cmd))
  } catch (err) {
    console.error(String(err?.message ?? err))
    process.exit(1)
  }
}
