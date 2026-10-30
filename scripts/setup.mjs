#!/usr/bin/env node
// Setup, two ways:
//
//   npm run setup                         asks you questions (for a person at a terminal)
//   npm run setup -- --file .env.setup    reads the answers from a file (for your coding agent; see SETUP.md)
//
// Either way it builds the sandbox template, deploys the Worker and stores each secret with
// `wrangler secret put`. It never prints a secret. Every step is safe to repeat, so run it again
// after you add a missing value; it ends by printing what is still to do.

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'

const WRANGLER = ['npx', '--yes', 'wrangler']
const QUEUE = 'slack-agent-turns'
// Must match wrangler.jsonc.
const BUCKET = 'slack-agent-transcripts'
const DATABASE = 'slack-agent'
const fileArg = process.argv.indexOf('--file')
const FILE = fileArg !== -1 ? process.argv[fileArg + 1] : null
const SKIP_TEMPLATE = process.argv.includes('--skip-template')

const bold = (s) => `\x1b[1m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const step = (s) => console.log(`\n${bold('==')} ${s}`)

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: opts.capture ? ['inherit', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', ...opts })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
const wrangler = (args, opts) => run(WRANGLER[0], [...WRANGLER.slice(1), ...args], opts)

function putSecret(name, value) {
  const r = spawnSync(WRANGLER[0], [...WRANGLER.slice(1), 'secret', 'put', name], { input: value, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`could not store ${name}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`)
  console.log(`  stored ${name}`)
}

function existingSecrets() {
  const r = wrangler(['secret', 'list', '--format', 'json'], { capture: true })
  try {
    return new Set(JSON.parse(r.out.slice(r.out.indexOf('['))).map((s) => s.name))
  } catch {
    return new Set()
  }
}

function setVar(name, value) {
  const path = 'wrangler.jsonc'
  const text = readFileSync(path, 'utf8')
  writeFileSync(path, text.replace(new RegExp(`("${name}":\\s*)"[^"]*"`), `$1"${value}"`))
}

function findDatabaseId(name) {
  const r = wrangler(['d1', 'list', '--json'], { capture: true })
  try {
    const list = JSON.parse(r.out.slice(r.out.indexOf('[')))
    return list.find((d) => d.name === name)?.uuid ?? null
  } catch {
    return null
  }
}

function setDatabaseId(id) {
  const path = 'wrangler.jsonc'
  const text = readFileSync(path, 'utf8')
  writeFileSync(path, text.replace(/("database_id":\s*)"[^"]*"/, `$1"${id}"`))
}

/** Reads KEY=value lines. Values may be quoted. Empty values count as missing. */
function readEnvFile(path) {
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2').trim()
    if (value) out[m[1]] = value
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Answers: from the file, or from questions.

let rl
let answers
if (FILE) {
  if (!existsSync(FILE)) {
    console.error(`${FILE} does not exist. Copy .env.setup.example to ${FILE} and fill it in.`)
    process.exit(1)
  }
  answers = readEnvFile(FILE)
} else {
  rl = createInterface({ input: stdin, output: stdout })
  answers = await askEverything()
}

const provider = (answers.SANDBOX_PROVIDER ?? '').toLowerCase()
if (provider !== 'e2b' && provider !== 'impello') {
  console.error('NEXT: set SANDBOX_PROVIDER to "e2b" or "impello", then run again.')
  process.exit(1)
}
const claudeName = answers.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : answers.CLAUDE_CODE_OAUTH_TOKEN ? 'CLAUDE_CODE_OAUTH_TOKEN' : null
const missing = [...(answers.SANDBOX_API_KEY ? [] : ['SANDBOX_API_KEY']), ...(claudeName ? [] : ['CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY'])]
if (missing.length) {
  console.error(`NEXT: fill in ${missing.join(', ')}${FILE ? ` in ${FILE}` : ''}, then run again.`)
  process.exit(1)
}

// ---------------------------------------------------------------------------------------------
step('Cloudflare login')
const whoami = wrangler(['whoami'], { capture: true })
if (!whoami.ok || /not authenticated|not logged in/i.test(whoami.out)) {
  if (FILE) {
    console.error('NEXT: not logged in to Cloudflare. The human runs `npx wrangler login` (it opens a browser), then run setup again.')
    process.exit(1)
  }
  wrangler(['login'])
}
console.log(dim('  Workers Paid must be on: dash.cloudflare.com > Workers & Pages > Plans.'))

step(`Sandbox template on ${provider}`)
setVar('SANDBOX_PROVIDER', provider)
if (SKIP_TEMPLATE) {
  console.log('  skipped (--skip-template)')
} else {
  const build = run('npm', ['run', '-s', 'template:build'], {
    env: { ...process.env, SANDBOX_PROVIDER: provider, SANDBOX_API_KEY: answers.SANDBOX_API_KEY },
  })
  if (!build.ok) {
    console.error('NEXT: the template build failed. Check SANDBOX_PROVIDER and SANDBOX_API_KEY, then run again.')
    process.exit(1)
  }
}

step('Queue, bucket, database and Worker')
const queue = wrangler(['queues', 'create', QUEUE], { capture: true })
if (!queue.ok && !/already exists|already taken|11009/i.test(queue.out)) {
  console.error(queue.out)
  console.error('NEXT: could not create the queue. Check that Workers Paid is on for this Cloudflare account.')
  process.exit(1)
}

// The transcript backups. No lifecycle rule: they are kept forever (see the README on cost).
const bucket = wrangler(['r2', 'bucket', 'create', BUCKET], { capture: true })
if (!bucket.ok && !/already exists|already own|10004/i.test(bucket.out)) {
  console.error(bucket.out)
  console.error('NEXT: could not create the R2 bucket. Open R2 once in the Cloudflare dashboard to turn it on, then run again.')
  process.exit(1)
}
console.log(`  R2 bucket ${BUCKET} ready`)

const db = wrangler(['d1', 'create', DATABASE], { capture: true })
if (!db.ok && !/already exists|7502/i.test(db.out)) {
  console.error(db.out)
  console.error('NEXT: could not create the D1 database. Fix the error above, then run again.')
  process.exit(1)
}
const databaseId = findDatabaseId(DATABASE)
if (!databaseId) {
  console.error(`NEXT: created the D1 database, but \`wrangler d1 list\` does not show ${DATABASE}. Run setup again.`)
  process.exit(1)
}
setDatabaseId(databaseId)
// CI=1 answers wrangler's "Ok to proceed?" for us. Applied migrations are skipped, so this repeats safely.
const migrate = wrangler(['d1', 'migrations', 'apply', DATABASE, '--remote'], { capture: true, env: { ...process.env, CI: '1' } })
if (!migrate.ok) {
  console.error(migrate.out)
  console.error('NEXT: the database migrations failed. Fix the error above, then run again.')
  process.exit(1)
}
console.log(`  D1 database ${DATABASE} ready, migrations applied`)

const deploy = wrangler(['deploy'], { capture: true })
if (!deploy.ok) {
  console.error(deploy.out)
  process.exit(1)
}
const workerUrl = deploy.out.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0]
console.log(`  deployed: ${workerUrl ?? '(no workers.dev URL in the output; find it in the Cloudflare dashboard)'}`)

step('Secrets')
const have = existingSecrets()
putSecret('SANDBOX_API_KEY', answers.SANDBOX_API_KEY)
putSecret(claudeName, answers[claudeName])
// Generated once. Replacing it would cut off any turn that is running right now.
if (!have.has('CALLBACK_SECRET')) putSecret('CALLBACK_SECRET', randomBytes(32).toString('hex'))

const next = []
if (workerUrl) {
  writeFileSync('slack-manifest.local.json', readFileSync('slack-manifest.json', 'utf8').replaceAll('https://YOUR-WORKER.workers.dev', workerUrl))
}
if (answers.SLACK_SIGNING_SECRET && answers.SLACK_BOT_TOKEN) {
  putSecret('SLACK_SIGNING_SECRET', answers.SLACK_SIGNING_SECRET)
  putSecret('SLACK_BOT_TOKEN', answers.SLACK_BOT_TOKEN)
} else {
  next.push(
    'The human creates the Slack app: https://api.slack.com/apps > Create New App > From a manifest > pick the workspace > ' +
      'paste the contents of slack-manifest.local.json > Create > Install to Workspace. Then they put the Signing Secret ' +
      '(Basic Information page) into SLACK_SIGNING_SECRET and the Bot User OAuth Token, xoxb-... (OAuth & Permissions page), ' +
      'into SLACK_BOT_TOKEN, and you run setup again.',
  )
}

if (answers.GITHUB_APP_ID && answers.GITHUB_APP_PRIVATE_KEY_PATH) {
  if (!existsSync(answers.GITHUB_APP_PRIVATE_KEY_PATH)) {
    next.push(`GITHUB_APP_PRIVATE_KEY_PATH is ${answers.GITHUB_APP_PRIVATE_KEY_PATH}, and no file is there. Fix the path and run again.`)
  } else {
    putSecret('GITHUB_APP_ID', answers.GITHUB_APP_ID)
    putSecret('GITHUB_APP_PRIVATE_KEY', readFileSync(answers.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8'))
    if (answers.GITHUB_INSTALLATION_ID) putSecret('GITHUB_INSTALLATION_ID', answers.GITHUB_INSTALLATION_ID)
  }
}

rl?.close()
console.log(`\n${bold('Setup ran.')} Worker: ${workerUrl ?? '?'}`)
if (next.length) {
  for (const n of next) console.log(`NEXT: ${n}`)
} else {
  console.log("NEXT: the Slack app's Event Subscriptions page must show the Request URL as Verified (click Retry if not).")
  console.log('NEXT: invite the bot to a channel (/invite @percy-jr) and @mention it. Watch it with `npx wrangler tail`.')
}

// ---------------------------------------------------------------------------------------------
// Interactive mode.

async function askEverything() {
  console.log(bold('\nSlack agent setup\n'))
  console.log('You need: Cloudflare on Workers Paid ($5/month), a Slack workspace where you can install apps,')
  console.log('and a Claude plan or an Anthropic API key. Tip: your coding agent can do this for you; see SETUP.md.')
  const a = {}

  a.SANDBOX_PROVIDER = await choose('\nWhich sandbox provider do you want to use?', [
    { label: 'E2B', hint: 'e2b.dev, $100 free credit when you sign up', value: 'e2b' },
    { label: 'Impello', hint: 'impello.ai, 7-day free trial', value: 'impello' },
  ])
  console.log(a.SANDBOX_PROVIDER === 'e2b' ? 'Make a key at https://e2b.dev/dashboard.' : 'Make a key at https://dashboard.impello.ai (API Keys tab).')
  a.SANDBOX_API_KEY = await askHidden('Paste the API key:')

  const claude = await choose('\nHow should the bot sign in to Claude?', [
    { label: 'My Claude Pro or Max plan', hint: '`claude setup-token`; only YOU should use the bot', value: 'oauth' },
    { label: 'An Anthropic API key', hint: 'pay per use; the right choice for a team', value: 'api' },
  ])
  if (claude === 'oauth') {
    console.log("Anthropic's terms allow a plan token for your own use of Claude Code. Keep the bot in a workspace or")
    console.log('channel only you use. If other people will use it, pick the API key instead.')
    a.CLAUDE_CODE_OAUTH_TOKEN = await askHidden('Run `claude setup-token` in another terminal and paste the token:')
  } else {
    a.ANTHROPIC_API_KEY = await askHidden('Paste the API key:')
  }

  console.log('\nThe Slack app needs your Worker URL, which exists after the first deploy.')
  console.log('Skip these on the first run. Setup then tells you how to make the app, and you run it again.')
  a.SLACK_SIGNING_SECRET = await askHidden('Slack Signing Secret (Enter to skip):')
  a.SLACK_BOT_TOKEN = await askHidden('Slack Bot User OAuth Token (Enter to skip):')

  if ((await rl.question('\nSet up the GitHub App now (see README)? [y/N] ')).trim().toLowerCase().startsWith('y')) {
    a.GITHUB_APP_ID = (await rl.question('App ID: ')).trim()
    a.GITHUB_APP_PRIVATE_KEY_PATH = (await rl.question('Path to the private key (.pem): ')).trim()
  }
  return a
}

async function choose(question, options) {
  console.log(question)
  options.forEach((o, i) => console.log(`  ${bold(String(i + 1))}) ${o.label}${o.hint ? dim(`  ${o.hint}`) : ''}`))
  for (;;) {
    const n = Number(await rl.question('Pick a number: '))
    if (options[n - 1]) return options[n - 1].value
  }
}

/** Reads a line without echoing it, for keys and tokens. */
async function askHidden(question) {
  stdout.write(`${question} ${dim('(hidden)')} `)
  rl.pause()
  stdin.setRawMode?.(true)
  stdin.resume()
  let value = ''
  return await new Promise((resolve) => {
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onData)
          stdin.setRawMode?.(false)
          stdout.write('\n')
          rl.resume()
          return resolve(value.trim())
        }
        if (ch === '\u0003') process.exit(130)
        if (ch === '\u007f') value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.on('data', onData)
  })
}
