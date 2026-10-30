// Files under box/ are imported as text (the "rules" entry in wrangler.jsonc) and written into
// each sandbox.
declare module '*.md' {
  const text: string
  export default text
}
declare module '*/run-turn.mjs' {
  const text: string
  export default text
}
declare module '*/progress.mjs' {
  const text: string
  export default text
}
