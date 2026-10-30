# Slack Agent Starter

A Cloudflare Worker that runs Claude Code in a per-thread cloud sandbox (E2B or Impello) and
replies in Slack. The README explains the design; read it first.

**If you were asked to set this repo up, follow SETUP.md step by step.** Never ask the human to
paste a secret into the chat; secrets go in `.env.setup`.

- Run `npm test`, `npm run typecheck` and `npm run scan` before you commit.
- `src/thread.ts` holds the thread rules as plain functions. Change the rules there and add a test in
  `test/thread.test.ts`; `src/thread-state.ts` only stores data and calls them.
- Model aliases (`!model opus|sonnet|haiku`) and their ids live only in `src/models.ts`.
- D1 tables are made by numbered SQL files in `migrations/`; add a new file, never edit an applied
  one. `npm run setup` applies them. Query through `src/db.ts`, always with bound `?` values.
- Every sandbox-to-Worker door (`/sandbox/callback`, `/sandbox/transcript`) checks the one-turn token
  and builds every key, channel and thread from the token's claims, never from the request body.
- Never put the Slack bot token, the signing secret or `CALLBACK_SECRET` into a sandbox
  (`test/sandbox-config.test.ts` checks this).
- Sandboxes pause on timeout, never kill: the Claude transcript lives on the sandbox's disk.
- Secrets go in with `npx wrangler secret put`. Never commit `.dev.vars` or a key.
- `box/` files are written into every sandbox on every turn. A change there reaches running threads
  on the next deploy; a change to `template/Dockerfile` needs `npm run template:build`.
