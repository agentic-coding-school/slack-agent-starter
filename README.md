# Slack Agent Starter

Your own coding agent in Slack. @mention it in a thread, and it runs **Claude Code** in its own
cloud sandbox and replies in the thread. Follow-ups in the thread continue the same conversation.
It remembers what it learns in each channel, in a private GitHub repo you own, and through the
same GitHub App it can clone your repos and open pull requests.

It runs on **Cloudflare Workers**, and the sandbox runs on **E2B** or **Impello** (you pick).

```
 Slack ──@mention──▶ Worker ──queue──▶ sandbox (one per thread)
   ▲                  │                    │  claude -p --resume <thread session>
   └──── reply ◀──────┴──◀── callback ─────┘  (posts its own answer back)
```

## What you need

| Thing | Cost | Notes |
|---|---|---|
| Cloudflare account on **Workers Paid** | $5/month | The free plan's CPU limit is too small for the sandbox calls. Setup also makes a D1 database and an R2 bucket (both have a free allowance). |
| A sandbox provider: **E2B** or **Impello** | E2B: $100 free credit. Impello: 7-day free trial. | Setup asks which one. |
| Claude: a **Pro/Max plan** or an **Anthropic API key** | Your plan, or pay per use | Read [Which Claude sign-in?](#which-claude-sign-in) first. |
| A Slack workspace where you can install apps | Free | |
| Node.js 22.6 or newer | Free | `node --version` |
| A GitHub account | Free | Required: the bot's memory lives in a private repo, reached through a GitHub App. |

## Setup

### The easy way: let your coding agent do it

1. Click **Use this template** at the top of this page, then clone your copy.
2. Open the folder in Claude Code (or Codex, or any coding agent) and say:

   > Set up this repo by following SETUP.md.

The agent asks you two questions (E2B or Impello? Claude plan or API key?), runs every command, and
tells you when you need to do something by hand: log in to Cloudflare, make the keys, and create the
Slack app. **You put the keys in a file, `.env.setup`, never in the chat.** The file is git-ignored.

### By hand

```bash
npm install
npm run setup
```

It asks the same questions in the terminal. The Slack app needs your Worker URL, so the first run
deploys the Worker and tells you how to make the app; then you run `npm run setup` again with the
Slack secrets. Every step is safe to repeat.

Every secret is stored with `wrangler secret put`. None of them go in a file in this repo. Setup
makes two random ones once and keeps them: `CALLBACK_SECRET` (signs the sandbox's tokens) and
`CHANNEL_SECRETS_KEY` (encrypts channel secrets; replacing it makes every stored channel secret unreadable).

When it is done, invite the bot to a channel (`/invite @percy-jr`) and @mention it.

### Which sandbox provider?

Both work the same way. Pick one, and setup handles the rest.

- **E2B** ([e2b.dev](https://e2b.dev)): sign up, then make a key on the dashboard. New accounts get
  $100 of credit. The Hobby plan stops a sandbox after 1 hour of continuous running, so a single
  turn is limited to 45 minutes by default.
- **Impello** ([impello.ai](https://www.impello.ai)): sign up at
  [dashboard.impello.ai](https://dashboard.impello.ai/sign-up), then make a key on the API Keys tab.
  7-day free trial.

To switch later, run `npm run setup` again and pick the other one.

### Which Claude sign-in?

- **Your Pro or Max plan** (`claude setup-token`). No extra cost. **Anthropic's terms allow a plan
  token for your own use of Claude Code.** Put the bot in a workspace or a channel that only you use.
  Anyone who can @mention the bot spends your plan.
- **An Anthropic API key** ([console.anthropic.com](https://console.anthropic.com)). You pay per
  token. Use this if other people will use the bot. A long coding turn can cost several dollars.

The bot answers **anyone** in the workspace who @mentions it. This is on purpose: it keeps the
starter simple. Pick the workspace, the channel and the sign-in with that in mind.

## GitHub App (required)

The bot keeps its memory in a private GitHub repo and reaches it through a GitHub App you make. The
same App lets it clone your repos, push a branch and open a pull request.

0. Create the memory repo first: **GitHub > New repository**, name it (for example `my-bot-memory`),
   make it **Private**, and tick **Add a README** (the bot cannot write to an empty repo).

1. Go to **GitHub > Settings > Developer settings > GitHub Apps > New GitHub App**.
2. Name it anything. Homepage URL: your Worker URL. **Untick Webhook > Active.**
3. Repository permissions: **Contents: Read and write**, **Pull requests: Read and write**.
   Metadata (read) is added for you.
4. "Where can this GitHub App be installed?": **Only on this account**. Click **Create**.
5. Note the **App ID**. Scroll down and click **Generate a private key**. A `.pem` file downloads.
6. Click **Install App**, then pick **Only select repositories** and choose the **memory repo** and
   the repos the bot may work in.
7. Run `npm run setup` again and give it the App ID, the `.pem` path and the memory repo
   (`owner/name`, which goes into `MEMORY_REPO` in `wrangler.jsonc`).

**Protect your main branch.** In each repo: Settings > Rules > Rulesets > New branch ruleset,
target `main`, and tick **Require a pull request before merging**. The bot is told never to push to
`main`, but a rule is what actually stops it.

What the bot's GitHub token can do: it lasts 1 hour, reaches only the repos you picked in step 6
**except the memory repo**, and can only read and write code and pull requests. The sandbox never
gets a token for the memory repo; see [Memory](#memory).

## How it works

- **One sandbox per thread.** The Worker finds a thread's sandbox by the thread id stored on the
  sandbox itself, so no database is needed. The Claude session id is made from the thread id, so
  `claude --resume` finds the conversation the same way.
- **Paused, not deleted.** 5 minutes after a thread goes quiet, its sandbox is paused. A paused
  sandbox costs no compute and keeps its disk, so the next message in the thread resumes it in a
  few seconds with its history and files.
- **One turn at a time.** Each thread has a Cloudflare Durable Object that lets one Claude turn run at a
  time. A message with files that arrives during a turn gets an ⏳ and goes into the next turn.
- **Follow-ups reach the running turn.** A plain follow-up sent while Claude works ("actually, use
  the other branch") gets a 📨 instead. The sandbox picks it up on its next report to
  `/sandbox/progress`, drops it in an inbox folder, and a Claude Code hook (`box/inbox-hook.mjs`,
  PostToolUse) hands it to Claude after its next tool call. Claude covers it in the same reply, so
  there is no second answer, and the status line shows "Read your new message". The follow-up gets
  a ✅ only if Claude read it AND the turn answered. If the turn fails, is stopped or is lost, or
  Claude never made another tool call, the follow-up runs as the next turn: a race can cost a
  second answer, never a message. Follow-ups with files, after a Stop, behind a queued message, or
  after a `!model` change wait for the next turn as before.
- **Nothing waits for Claude.** The Worker starts Claude in the sandbox and returns. When Claude is
  done, the sandbox posts its answer back to `/sandbox/callback`. A turn can take as long as it needs
  (up to the limit), far longer than any Worker request.
- **You can watch it work, and stop it.** When a turn starts, the Worker posts a status message
  under your message: what Claude is doing now (`Running npm test · 14 steps · 3m`), a **Follow
  along** link to the turn's transcript page (`/ui/follow`, part of the web UI), and a **Stop**
  button. The sandbox reports to `/sandbox/progress` every 10 seconds and the Worker edits the
  message; the sandbox never holds the Slack token. Stop goes to `/slack/interactive` (signature
  checked), which marks the turn; the sandbox sees the mark on its next report, ends Claude, and the
  bot posts "Stopped". When the answer arrives it is a new message, and the status message is
  deleted. Anyone who can see the thread can press Stop, as anyone can talk to the bot.
- **Every turn is backed up.** After each turn the sandbox copies the thread's Claude transcript to
  an R2 bucket through `/sandbox/transcript`, using its one-turn token. The Worker picks the object
  key from the token (`transcripts/<channel>/<thread>/<turn>.jsonl.gz`), so a sandbox can only write
  its own thread's backups. Backups are kept forever; a D1 table indexes them.
- **Files go both ways, without the Slack token.** Files dropped in the thread reach Claude as files
  in `~/work/slack-files/`. When a turn starts, the Worker writes a manifest into the sandbox with a
  signed grant for each file that turn's messages carried. Before Claude starts, the sandbox swaps
  each grant for the bytes at `/sandbox/file`, which checks the grant, asks Slack the file is in that
  channel, and streams it through with the bot token. A grant opens one file in one thread, so
  Claude can never pull a file from another channel. Claude posts files and canvases back with
  `node ~/.agent/tools.mjs upload|canvas` (`/sandbox/upload`, `/sandbox/canvas`), using a second
  token of its own that can only post into its own thread, and cannot deliver the answer or stop the
  turn. A canvas is shared with the channel, so its members can edit it.
- **Search sees public channels only.** Claude searches the workspace with
  `node ~/.agent/tools.mjs search "<question>"`, which calls `/sandbox/search` with the same tools
  token. The Worker asks Slack's `assistant.search.context` with the bot token (scope
  `search:read.public`) for public-channel messages, then checks every result's channel with
  `conversations.info` and drops anything that is not a public channel, so a private channel, a DM
  or a group DM never reaches Claude. Slack lets a bot search only with the short-lived
  `action_token` it puts on an @mention or a DM, so search works in turns started that way; a
  follow-up typed without a mention may be refused, and Claude asks for a mention. The thread keeps
  the token; it never enters the sandbox.
- **Watched channels answer without a mention.** A channel you mark as watched on the web UI's
  Channels page gets an answer to every new root message, no @mention needed. Elsewhere a thread
  starts with an @mention. Either way, replies in a thread the bot answers reach it without one.
- **Channel secrets reach that channel only.** On the same page you can give a channel secrets
  (say, an API key its work needs). They are stored encrypted (AES-GCM) in D1 with the Worker secret
  `CHANNEL_SECRETS_KEY`, and only that channel's sandboxes get them, as environment variables for
  Claude. Claude is told their names, never their values. Treat a secret as readable by anyone who
  can talk to the bot in that channel: Claude can print its own environment. They are never set
  from Slack, and the page shows names only.
- **It remembers, per channel.** Claude Code's own auto memory writes notes into a folder, and the
  bot keeps that folder in your memory repo, one folder per channel. See [Memory](#memory).
- **The Slack token never enters the sandbox.** The sandbox gets a token that can post one turn's answer
  into one thread, and it expires. Claude reads text anyone can write, so the sandbox holds as little
  as possible.

| File | What it does |
|---|---|
| `src/index.ts` | The Slack events and interactivity routes, the sandbox doors, the queue consumer |
| `src/thread.ts` | The thread rules: one turn at a time, dedupe, mid-turn follow-ups, when to pause |
| `src/thread-state.ts` | The Durable Object that stores a thread and runs its alarm |
| `src/turn.ts` | Starts one turn: prompt, tokens, launch |
| `src/sandbox.ts` | E2B / Impello: find, create, pause, launch |
| `src/github.ts` | GitHub App tokens: the turn's (every repo but memory) and the memory repo's |
| `src/memory.ts` | The memory rules: one folder per channel, which paths sync, merging two threads' notes |
| `src/memory-store.ts` | Reads and commits a channel's memory folder through GitHub's API |
| `src/models.ts` | The `!model` aliases and their model ids, in one place |
| `src/status.ts` | The live status message and the Stop button: the line, its caps, reading a click |
| `src/transcripts.ts` | The transcript backup rules: the R2 key, the size limit |
| `src/files.ts` | The file rules, both ways: grants, caps, the checks on uploads and canvases |
| `src/search.ts` | The search rules: public channels only, the request Slack gets, the result shape |
| `src/channels.ts` | The channel rules: watched channels, the default model, secret names and their encryption |
| `src/channel-store.ts` | Reads and writes channel settings and encrypted secrets in D1 |
| `src/db.ts` | The D1 database helpers |
| `migrations/` | The D1 tables. `npm run setup` applies them |
| `box/run-turn.mjs` | Runs inside the sandbox: runs Claude, reports progress, posts the answer back |
| `box/progress.mjs` | Runs inside the sandbox: turns Claude's stream events into the status line |
| `box/memory.mjs` | Runs inside the sandbox: pulls the channel's notes before Claude starts and pushes what changed |
| `box/files.mjs` | Runs inside the sandbox: downloads the turn's files before Claude starts |
| `box/tools.mjs` | Runs inside the sandbox: Claude's commands to post a file or a canvas into its thread, and to search public channels |
| `box/inbox.mjs`, `box/inbox-hook.mjs` | Runs inside the sandbox: follow-ups sent mid-turn, and the hook that hands them to Claude |
| `box/CLAUDE.md` | The instructions Claude reads in the sandbox. Edit this to change the bot's behavior. |
| `template/Dockerfile` | The sandbox image. Run `npm run template:build` after you change it. |

## Pick the model

Each thread runs on **Opus** unless you say otherwise. Send `!model sonnet` (or `opus`, `haiku`) in
the thread, on its own, to switch; `!model` alone shows the current one. A turn that is already
running keeps its model, and the switch applies from the next turn. A channel can have its own
default model, set on the web UI's Channels page; a thread's `!model` pick still wins over it. The
aliases and the model ids they map to live in `src/models.ts`.

## Memory

The bot remembers. It uses **Claude Code's own auto memory**: Claude reads a `MEMORY.md` index when
a turn starts and writes short notes as it learns (a decision, how your repo builds, a gotcha). Those
notes live in your **memory repo**, one folder per Slack channel, named by the channel id:

```
my-bot-memory/
  C1EXAMPLE01/MEMORY.md
  C1EXAMPLE01/deploy_steps.md
```

- **Each turn:** before Claude starts, the sandbox pulls its channel's folder from `/sandbox/memory`
  and points auto memory at it. After Claude stops, it sends what changed back to the same door,
  and the Worker commits it to the repo. A commit message names the channel and the thread.
- **A channel sees only its own folder.** The Worker picks the folder from the sandbox's one-turn
  token, never from the request, and the sandbox never holds a token for the memory repo: the turn's
  GitHub token is minted for every installed repo except that one. So a private channel's memory is
  never shared with another channel.
- **Two threads at once** in one channel merge: the index keeps both sides' lines, and a note both
  changed keeps the stored version with the other saved beside it as `<name>.conflict-<turn>.md`.
  A failed push is kept in the sandbox and sent with the next turn.
- **Read it, fix it, undo it.** It is a git repo: browse it on GitHub, edit or delete a note, or
  revert a commit. Do look now and then. Anyone who can talk to the bot can teach it something, and
  a note **outlives the thread**: it is read by every later thread in that channel.

## Transcript backups

Every turn's transcript is copied to the R2 bucket `slack-agent-transcripts` and **never deleted**:
the bucket has no lifecycle rule. Transcripts are small (gzipped text) and R2 storage is cheap, but
it grows with every turn. To keep less, add a lifecycle rule to the bucket in the Cloudflare
dashboard (R2 > the bucket > Settings > Object lifecycle rules).

## Settings

In `wrangler.jsonc` under `vars`. Run `npm run deploy` after you change one.

| Var | Default | What it does |
|---|---|---|
| `MAX_TURN_MINUTES` | 45 | How long one turn may run. Keep it under 50 on E2B Hobby. |
| `IDLE_PAUSE_MINUTES` | 5 | How long a thread may be quiet before its sandbox pauses. |
| `SANDBOX_TEMPLATE` | `slack-agent` | The sandbox image name. |
| `MEMORY_REPO` | (set by setup) | The memory repo, `owner/name`. Required. |

## When something goes wrong

- **See the logs:** `npx wrangler tail`
- **No reply and no 👀:** Slack is not reaching the Worker. In the Slack app's Event Subscriptions,
  check that the Request URL is verified (click Retry), and that the bot is in the channel.
- **👀 but no reply:** the turn failed to start or is still running. `npx wrangler tail` shows why.
  A turn that never reports back is released after its limit, with a note in the thread.
- **Stop does nothing:** check that Interactivity is on in the Slack app with the Request URL
  `<worker>/slack/interactive`. A click is seen by the sandbox on its next report (up to 10 seconds).
- **"Invalid API key" from Claude:** the Claude secret is wrong or expired. Run
  `npx wrangler secret put CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) again.

## Develop

```bash
npm test            # unit tests
npm run typecheck
npm run scan        # checks the repo and its history for secrets
npm run deploy
```

## License

MIT
