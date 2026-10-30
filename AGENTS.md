# Slack Agent Starter

A Cloudflare Worker that runs Claude Code in a per-thread cloud sandbox (E2B or Impello) and
replies in Slack. The README explains the design; read it first.

**If you were asked to set this repo up, follow SETUP.md step by step.** Never ask the human to
paste a secret into the chat; secrets go in `.env.setup`.

- Run `npm test`, `npm run typecheck` and `npm run scan` before you commit.
- `src/thread.ts` holds the thread rules as plain functions. Change the rules there and add a test in
  `test/thread.test.ts`; `src/thread-state.ts` only stores data and calls them.
- Mid-turn follow-ups (rule 7 in `src/thread.ts`) are never lost: one counts as answered only when
  the sandbox says Claude took it AND the turn answered; every other path puts it back in `pending`.
  Keep it that way. The sandbox half is `box/inbox.mjs` + `box/inbox-hook.mjs` (`test/inbox.test.ts`,
  and `test/run-turn.test.ts` runs it end to end).
- Model aliases (`!model opus|sonnet|haiku`) and their ids live only in `src/models.ts`.
- D1 tables are made by numbered SQL files in `migrations/`; add a new file, never edit an applied
  one. `npm run setup` applies them. Query through `src/db.ts`, always with bound `?` values.
- Every sandbox-to-Worker door (`/sandbox/callback`, `/sandbox/transcript`, `/sandbox/progress`,
  `/sandbox/memory`, `/sandbox/upload`, `/sandbox/canvas`, `/sandbox/search`, `/sandbox/file`) checks a signed token and builds every key,
  channel and thread from the token's claims, never from the request body. Each token purpose signs
  with its own key (`src/callback-token.ts`): `reply` (the runner only; Claude never sees it),
  `tools` (Claude's, for upload, canvas and search), `file` (one grant per Slack file, `src/files.ts`). Text a sandbox sends for Slack is capped and escaped (`src/status.ts`).
- Slack's own routes (`/slack/events`, `/slack/interactive`) check the signing secret before reading
  the body. The Stop button only marks the turn (rule 6 in `src/thread.ts`); the sandbox ends it.
- Never put the Slack bot token, the signing secret or `CALLBACK_SECRET` into a sandbox
  (`test/sandbox-config.test.ts` checks this).
- Sandboxes pause on timeout, never kill: the Claude transcript lives on the sandbox's disk.
- Secrets go in with `npx wrangler secret put`. Never commit `.dev.vars` or a key.
- `box/` files are written into every sandbox on every turn (`run-turn.mjs` imports `progress.mjs`,
  `inbox.mjs` and `files.mjs` from beside it, and `inbox-hook.mjs` imports `inbox.mjs`; a new box file must be added to the write list in `src/sandbox.ts`). A change there reaches running threads
  on the next deploy; a change to `template/Dockerfile` needs `npm run template:build`.
- Workspace search (`/sandbox/search`, `src/search.ts`) answers from PUBLIC channels only: the bot
  token, `channel_types: public_channel`, and a `conversations.info` check on every result, which
  drops anything Slack does not call a public channel. Slack lets a bot token search only with the
  `action_token` from an @mention or DM event; the thread keeps it (rule 8 in `src/thread.ts`) and it
  never enters the sandbox. Never add a user token for search.
- Channel settings (`src/channels.ts` rules, `src/channel-store.ts` D1): watched channels, the
  channel's default model (rule 9 in `src/thread.ts`), and per-channel secrets. Secrets are set only
  from the web UI, never from Slack; they are AES-GCM encrypted with `CHANNEL_SECRETS_KEY`, bound to
  their channel and name, and handed to a turn by the job's own channel (`src/turn.ts`). In
  `src/sandbox.ts` they are spread FIRST into the runner's envs so no built-in can be overridden,
  and reserved names are refused (`checkSecretName`). Never return a value to a page or a log.
- Memory (`src/memory.ts`, `src/memory-store.ts`, `box/memory.mjs`) is Claude Code's own auto memory
  kept in the `MEMORY_REPO` git repo, one folder per channel. The Worker picks the folder from the
  token's channel and commits through GitHub's API with a token for that repo only; the sandbox never
  gets a token that reaches it (`mintTurnToken` in `src/github.ts` leaves it out). Keep both, or one
  channel could read another's, private ones included. The GitHub App and `MEMORY_REPO` are required
  (`githubMissing`). Do not add a memory skill or recall tool: auto memory already loads the index.
