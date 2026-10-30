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
  `/sandbox/upload`, `/sandbox/canvas`, `/sandbox/file`) checks a signed token and builds every key,
  channel and thread from the token's claims, never from the request body. Each token purpose signs
  with its own key (`src/callback-token.ts`): `reply` (the runner only; Claude never sees it),
  `tools` (Claude's, for upload and canvas), `file` (one grant per Slack file, `src/files.ts`). Text a sandbox sends for Slack is capped and escaped (`src/status.ts`).
- Slack's own routes (`/slack/events`, `/slack/interactive`) check the signing secret before reading
  the body. The Stop button only marks the turn (rule 6 in `src/thread.ts`); the sandbox ends it.
- Never put the Slack bot token, the signing secret or `CALLBACK_SECRET` into a sandbox
  (`test/sandbox-config.test.ts` checks this).
- Sandboxes pause on timeout, never kill: the Claude transcript lives on the sandbox's disk.
- Secrets go in with `npx wrangler secret put`. Never commit `.dev.vars` or a key.
- `box/` files are written into every sandbox on every turn (`run-turn.mjs` imports `progress.mjs`,
  `inbox.mjs` and `files.mjs` from beside it, and `inbox-hook.mjs` imports `inbox.mjs`; a new box file must be added to the write list in `src/sandbox.ts`). A change there reaches running threads
  on the next deploy; a change to `template/Dockerfile` needs `npm run template:build`.
