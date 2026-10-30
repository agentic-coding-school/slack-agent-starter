# Slack Agent Starter

Your own coding agent in Slack. @mention it in a thread, and it runs **Claude Code** in its own
cloud sandbox and replies in the thread. Follow-ups in the thread continue the same conversation.
With the optional GitHub App, it can clone your repos and open pull requests.

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
| A GitHub account (optional) | Free | Only for the pull request feature. |

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

Every secret is stored with `wrangler secret put`. None of them go in a file in this repo.

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

## GitHub App (optional)

With this, the bot can clone your repos, push a branch and open a pull request.

1. Go to **GitHub > Settings > Developer settings > GitHub Apps > New GitHub App**.
2. Name it anything. Homepage URL: your Worker URL. **Untick Webhook > Active.**
3. Repository permissions: **Contents: Read and write**, **Pull requests: Read and write**.
   Metadata (read) is added for you.
4. "Where can this GitHub App be installed?": **Only on this account**. Click **Create**.
5. Note the **App ID**. Scroll down and click **Generate a private key**. A `.pem` file downloads.
6. Click **Install App**, then pick **Only select repositories** and choose the repos the bot may use.
7. Run `npm run setup` again (or just its GitHub step) and give it the App ID and the `.pem` path.

**Protect your main branch.** In each repo: Settings > Rules > Rulesets > New branch ruleset,
target `main`, and tick **Require a pull request before merging**. The bot is told never to push to
`main`, but a rule is what actually stops it.

What the bot's GitHub token can do: it lasts 1 hour, reaches only the repos you picked in step 6, and
can only read and write code and pull requests.

## How it works

- **One sandbox per thread.** The Worker finds a thread's sandbox by the thread id stored on the
  sandbox itself, so no database is needed. The Claude session id is made from the thread id, so
  `claude --resume` finds the conversation the same way.
- **Paused, not deleted.** 5 minutes after a thread goes quiet, its sandbox is paused. A paused
  sandbox costs no compute and keeps its disk, so the next message in the thread resumes it in a
  few seconds with its history and files.
- **One turn at a time.** Each thread has a Cloudflare Durable Object that lets one Claude turn run at a
  time. Messages that arrive during a turn get an ⏳ and go into the next turn together.
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
- **The Slack token never enters the sandbox.** The sandbox gets a token that can post one turn's answer
  into one thread, and it expires. Claude reads text anyone can write, so the sandbox holds as little
  as possible.

| File | What it does |
|---|---|
| `src/index.ts` | The Slack events and interactivity routes, the sandbox doors, the queue consumer |
| `src/thread.ts` | The thread rules: one turn at a time, dedupe, when to pause |
| `src/thread-state.ts` | The Durable Object that stores a thread and runs its alarm |
| `src/turn.ts` | Starts one turn: prompt, tokens, launch |
| `src/sandbox.ts` | E2B / Impello: find, create, pause, launch |
| `src/github.ts` | GitHub App tokens |
| `src/models.ts` | The `!model` aliases and their model ids, in one place |
| `src/status.ts` | The live status message and the Stop button: the line, its caps, reading a click |
| `src/transcripts.ts` | The transcript backup rules: the R2 key, the size limit |
| `src/db.ts` | The D1 database helpers |
| `migrations/` | The D1 tables. `npm run setup` applies them |
| `box/run-turn.mjs` | Runs inside the sandbox: runs Claude, reports progress, posts the answer back |
| `box/progress.mjs` | Runs inside the sandbox: turns Claude's stream events into the status line |
| `box/CLAUDE.md` | The instructions Claude reads in the sandbox. Edit this to change the bot's behavior. |
| `template/Dockerfile` | The sandbox image. Run `npm run template:build` after you change it. |

## Pick the model

Each thread runs on **Opus** unless you say otherwise. Send `!model sonnet` (or `opus`, `haiku`) in
the thread, on its own, to switch; `!model` alone shows the current one. A turn that is already
running keeps its model, and the switch applies from the next turn. The aliases and the model ids
they map to live in `src/models.ts`.

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
