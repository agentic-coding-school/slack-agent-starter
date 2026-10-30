// What Claude is doing, read from `claude -p --output-format stream-json`, for the live status
// message in Slack. Plain functions so test/progress.test.ts can check them without a sandbox.
// run-turn.mjs imports this from beside itself; the Worker writes both files (src/sandbox.ts).
//
// The Worker treats every word of this as untrusted and caps and escapes it (src/status.ts), so
// this file only has to be useful, not safe.

/** How often the runner reports to the Worker, and so how soon a Stop click lands. */
export const TICK_MS = 10_000

/** An unchanged status is re-sent this often anyway, so the clock in Slack keeps moving. */
export const RESEND_MS = 60_000

/** A fresh tracker for one turn. Feed it every stream event; read `activity` and `steps`. */
export function createProgress() {
  return { activity: 'Thinking…', steps: 0 }
}

/** Updates the tracker from one stream-json event. Returns true when what it shows changed. */
export function onStreamEvent(progress, event) {
  if (event?.type !== 'assistant') return false
  const content = Array.isArray(event.message?.content) ? event.message.content : []
  let changed = false
  for (const block of content) {
    if (block?.type === 'tool_use') {
      progress.steps += 1
      progress.activity = describeTool(block.name, block.input ?? {})
      changed = true
    } else if (block?.type === 'text' && block.text?.trim()) {
      progress.activity = 'Writing…'
      changed = true
    } else if (block?.type === 'thinking') {
      progress.activity = 'Thinking…'
      changed = true
    }
  }
  return changed
}

/** One short line per tool call: what a person watching would want to know. */
export function describeTool(name, input) {
  switch (name) {
    case 'Bash':
      return `Running ${code(firstLine(input.command), 80)}`
    case 'Read':
      return `Reading ${code(baseName(input.file_path))}`
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return `Editing ${code(baseName(input.file_path ?? input.notebook_path))}`
    case 'Grep':
    case 'Glob':
      return `Searching for ${code(input.pattern, 60)}`
    case 'WebSearch':
      return `Searching the web for ${code(input.query, 60)}`
    case 'WebFetch':
      return `Reading ${code(hostOf(input.url))}`
    case 'Task':
    case 'Agent':
      return `Starting a helper: ${clip(input.description ?? 'subtask', 60)}`
    case 'TodoWrite':
      return 'Updating its to-do list'
    default:
      return `Using ${code(name ?? 'a tool', 60)}`
  }
}

/** True when the runner should send the status with this tick (it always sends the tick itself). */
export function shouldSendStatus({ changed, lastSentAt, now }) {
  return changed || now - lastSentAt >= RESEND_MS
}

function code(text, max = 60) {
  const t = clip(String(text ?? '').replaceAll('`', "'"), max)
  return t ? `\`${t}\`` : '…'
}

function clip(text, max) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

function firstLine(text) {
  return String(text ?? '').split('\n')[0]
}

function baseName(path) {
  return String(path ?? '').split('/').filter(Boolean).at(-1) ?? ''
}

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return 'a web page'
  }
}
