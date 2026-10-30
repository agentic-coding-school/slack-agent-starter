# Setup guide for a coding agent

You are a coding agent (Claude Code, Codex or similar). The human asked you to set up this repo.
Follow these steps in order. They take about 15 minutes, most of it waiting on the human.

**The one rule: never ask the human to paste a key, token or secret into the chat.** Secrets go into
the file `.env.setup`, which the human edits and which git ignores. You never read the values in it
aloud, print them, or put them in a command. The setup script reads the file itself and never prints
a secret.

## 1. Check the machine

- `node --version` must be 22.6 or newer.
- Run `npm install`.
- Run `npx wrangler whoami`. If it says the human is not logged in, ask them to run
  `npx wrangler login` themselves (it opens a browser). Wait for them to say it is done.
- Tell the human: their Cloudflare account must be on **Workers Paid** ($5/month):
  dash.cloudflare.com > Workers & Pages > Plans. The free plan does not work. R2 must be turned on
  too: dash.cloudflare.com > R2 > Purchase / Get started (it has a free allowance).

## 2. Ask two questions

Ask each one on its own, with these options, and wait for the answer.

1. **Which sandbox provider: E2B or Impello?** Each Slack thread gets its own cloud computer from it.
   - E2B (e2b.dev): $100 of free credit on sign-up. Keys at https://e2b.dev/dashboard.
   - Impello (impello.ai): 7-day free trial. Keys at https://dashboard.impello.ai (API Keys tab).
2. **How does the bot sign in to Claude?**
   - Their Claude Pro or Max plan: they run `claude setup-token` and copy the token. Tell them:
     Anthropic's terms allow a plan token for their own use of Claude Code, so the bot must stay in a
     workspace or channel only they use.
   - An Anthropic API key (https://console.anthropic.com): pay per use. The right choice if other
     people will use the bot.

## 3. Make the file, and have the human fill it in

- Copy `.env.setup.example` to `.env.setup`.
- Write the provider they picked into `SANDBOX_PROVIDER` (`e2b` or `impello`). That is not a secret.
- Ask the human to open `.env.setup` in their editor and paste in `SANDBOX_API_KEY` and ONE of
  `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`, then save it and tell you. Leave the Slack, GitHub and
  `MEMORY_REPO` lines empty for now.

## 4. Run setup

```bash
npm run setup -- --file .env.setup
```

It builds the sandbox image (a few minutes the first time), creates the queue, the R2 bucket for
transcript backups and the D1 database (and applies `migrations/`), deploys the Worker (which also
turns on its every-minute Cron Trigger for routines), stores the secrets,
and writes `slack-manifest.local.json` with the Worker URL in it. It ends with `NEXT:` lines. Read
them and do what they say. If a step fails, the `NEXT:` line says why; fix that and run it again.
Running it again is always safe.

To skip the image build on later runs, add `--skip-template`.

## 5. The Slack app (the human does this)

Walk the human through it:

1. Open https://api.slack.com/apps and click **Create New App > From a manifest**.
2. Pick the workspace. Paste the contents of `slack-manifest.local.json` (you can show them the file;
   it holds no secret). Click **Create**, then **Install to Workspace**.
3. Paste the **Signing Secret** (Basic Information page) into `SLACK_SIGNING_SECRET` and the
   **Bot User OAuth Token**, `xoxb-...` (OAuth & Permissions page), into `SLACK_BOT_TOKEN` in
   `.env.setup`.

Then run `npm run setup -- --file .env.setup --skip-template` again. After it finishes, the human
opens **Event Subscriptions** in the Slack app and clicks **Retry** if the Request URL is not marked
Verified. The manifest also turns on **Interactivity** with the Request URL `<worker>/slack/interactive`
(it carries the Stop button's clicks); nothing to do there unless the Worker URL changes.

## 6. GitHub and the memory repo (required)

The bot keeps its memory in a private GitHub repo, so this step is not optional: a turn refuses to
start until it is done. Walk the human through "GitHub App" in the README:

1. They create a **private** repo for the memory (for example `my-bot-memory`) **with a README**.
2. They create the GitHub App with the permissions in README "GitHub App" step 3 (Contents and Pull
   requests: Read and write; Checks, Commit statuses and Actions: Read-only) and install it on the
   memory repo and on any repos the bot may work in.
3. They fill in `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` (the path to the downloaded `.pem`
   file) and `MEMORY_REPO` (`owner/name`, not a secret; you may write it yourself) in `.env.setup`.
4. The App's webhook stays **Active**: Webhook URL `<worker>/github/webhook` (setup printed the
   Worker URL), a Webhook secret they make, and the events in README "GitHub App" step 3. They put
   the same secret into `GITHUB_WEBHOOK_SECRET` in `.env.setup`. Do not make it or read it yourself.
   It is how the bot comes back to a PR it opened when CI fails or someone reviews.

Then run setup again with `--skip-template`. Remind them to protect `main` in the repos the bot
works in.

## 7. Test it

- Ask the human to invite the bot to a channel (`/invite @percy-jr`) and @mention it with a question.
- Run `npx wrangler tail --format pretty` while they do, and read it together. A 👀 on their message
  means the turn started. A status message with a **Stop** button appears under it and updates with
  what Claude is doing; the answer arrives in the thread and the status message goes away.
- Ask them to try **Stop** on a longer task: the status turns to "Stopping…" and within about 10
  seconds the bot posts "Stopped".
- Ask them to send a follow-up while a longer task runs ("also add a test"). It gets a 📨, the
  status line soon says "Read your new message", and the one answer covers both. Nothing to set up.
- If they have a test repo, ask the bot to open a small PR there. Its reply links the PR, and a
  comment on the PR from the human gets a :telescope: line in the thread about a minute later and a
  new turn. Merging it posts "stopped following".
- Ask them to tell the bot something worth keeping ("remember that we deploy with `npm run ship`"),
  then ask about it in a NEW thread in the same channel. The memory repo shows a commit named for
  the channel, and the new thread knows the answer.
- If nothing happens, see "When something goes wrong" in the README.

## 8. Finish

- Tell the human `.env.setup` can be deleted now (the secrets are stored in Cloudflare), and offer to
  delete it.
- Point them at README.md "How it works" for what each part does.
