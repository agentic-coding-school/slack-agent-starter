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
  dash.cloudflare.com > Workers & Pages > Plans. The free plan does not work.

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
  `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`, then save it and tell you. Leave the Slack and
  GitHub lines empty for now.

## 4. Run setup

```bash
npm run setup -- --file .env.setup
```

It builds the sandbox image (a few minutes the first time), deploys the Worker, stores the secrets,
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
Verified.

## 6. GitHub (optional)

Ask whether they want the bot to open pull requests. If yes, walk them through "GitHub App" in the
README, then have them fill in `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` (the path to the
downloaded `.pem` file) and run setup again with `--skip-template`. Remind them to protect `main`.

## 7. Test it

- Ask the human to invite the bot to a channel (`/invite @percy-jr`) and @mention it with a question.
- Run `npx wrangler tail --format pretty` while they do, and read it together. A 👀 on their message
  means the turn started; the answer arrives in the thread.
- If nothing happens, see "When something goes wrong" in the README.

## 8. Finish

- Tell the human `.env.setup` can be deleted now (the secrets are stored in Cloudflare), and offer to
  delete it.
- Point them at README.md "How it works" for what each part does.
