#!/usr/bin/env node
// Claude's tools for its own Slack thread. Claude runs them with Bash:
//
//   node ~/.agent/tools.mjs upload <file> [--title "Title"] [--comment "A line about it"]
//   node ~/.agent/tools.mjs canvas <markdown-file> --title "Title"
//   node ~/.agent/tools.mjs search "<question or words>" [--limit 10]
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
].join('\n')

/** Reads the command line. Returns the command, or `{ error }` with what is wrong. */
export function parseArgs(argv) {
  const [command, ...rest] = argv
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
