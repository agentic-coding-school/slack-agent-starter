// The sandbox side of files: the runner's downloads (box/files.mjs) and Claude's tools (box/tools.mjs).
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const box = join(dirname(fileURLToPath(import.meta.url)), '..', 'box')
const { downloadAll, filesNote } = await import(pathToFileURL(join(box, 'files.mjs')).href)
const { parseArgs, run } = await import(pathToFileURL(join(box, 'tools.mjs')).href)

async function withServer(handler: (req: IncomingMessage, res: ServerResponse) => void, body: (url: string) => Promise<void>) {
  const server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  try {
    await body(`http://127.0.0.1:${port}/sandbox/file`)
  } finally {
    server.close()
  }
}

test('downloads each granted file, keeps refused ones with their reason, and never leaves half a file', async () => {
  const work = mkdtempSync(join(tmpdir(), 'files-'))
  const grants: string[] = []
  await withServer(
    (req, res) => {
      const grant = String(req.headers.authorization).replace('Bearer ', '')
      grants.push(grant)
      if (grant === 'g-ok') {
        res.writeHead(200, { 'x-file-size': '5' })
        return res.end('hello')
      }
      if (grant === 'g-short') {
        res.writeHead(200, { 'x-file-size': '100' })
        return res.end('cut')
      }
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end('{"ok":false,"error":"file is not in this channel"}')
    },
    async (url) => {
      const results = await downloadAll({
        url,
        workDir: work,
        manifest: [
          { id: 'F1', name: 'a.txt', path: 'slack-files/F1-a.txt', size: 5, mimetype: 'text/plain', from: 'U1', grant: 'g-ok' },
          { id: 'F2', name: 'b.bin', path: 'slack-files/F2-b.bin', from: 'U1', grant: 'g-short' },
          { id: 'F3', name: 'c.png', path: 'slack-files/F3-c.png', from: 'U2', grant: 'g-gone' },
          { id: 'F4', name: 'd', path: '../../escape', from: 'U2', grant: 'g-ok' },
          { name: 'big.mov', from: 'U2', error: 'too large' },
        ],
      })
      assert.equal(readFileSync(join(work, 'slack-files', 'F1-a.txt'), 'utf8'), 'hello')
      assert.deepEqual(readdirSync(join(work, 'slack-files')), ['F1-a.txt'], 'no .part file, no short file')
      assert.equal(existsSync(join(work, '..', '..', 'escape')), false)
      assert.deepEqual(grants, ['g-ok', 'g-short', 'g-gone'], 'the escaping path is refused before any request')
      assert.equal(results[0].path, 'slack-files/F1-a.txt')
      assert.match(results[1].error, /got 3 of 100 bytes/)
      assert.match(results[2].error, /403 file is not in this channel/)
      assert.match(results[3].error, /bad path/)
      assert.equal(results[4].error, 'too large')

      const note = filesNote(results)
      assert.match(note, /- slack-files\/F1-a\.txt \(1 KB, text\/plain\) from <@U1>/)
      assert.match(note, /- big\.mov from <@U2>: too large/)
    },
  )
})

test('no files, no note', () => {
  assert.equal(filesNote([]), '')
})

test("Claude's tools read their command line strictly", () => {
  assert.deepEqual(parseArgs(['upload', 'out.html', '--title', 'Report', '--comment', 'Here']), {
    command: 'upload',
    path: 'out.html',
    title: 'Report',
    comment: 'Here',
  })
  assert.deepEqual(parseArgs(['canvas', 'plan.md', '--title', 'Plan']), { command: 'canvas', path: 'plan.md', title: 'Plan' })
  assert.ok(parseArgs(['canvas', 'plan.md']).error)
  assert.ok(parseArgs(['upload']).error)
  assert.ok(parseArgs(['upload', 'a', '--channel', 'C9']).error, 'no way to name another channel')
  assert.ok(parseArgs(['delete', 'x']).error)
  assert.ok(parseArgs([]).error)
})

test('upload sends the bytes with the tools token and encoded names, and no channel or thread', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tools-'))
  const path = join(dir, 'résumé.txt')
  writeFileSync(path, 'abc')
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return Response.json({ ok: true, permalink: 'https://s/f' })
  }
  const env = { AGENT_API_URL: 'https://w.example', AGENT_TOOLS_TOKEN: 'tok', TURN_ID: 't1' }
  const out = await run({ command: 'upload', path, title: 'Résumé' }, { env, fetchImpl })
  assert.equal(out, 'Posted résumé.txt in the thread: https://s/f')
  const headers = calls[0].init.headers as Record<string, string>
  assert.equal(calls[0].url, 'https://w.example/sandbox/upload')
  assert.equal(headers.authorization, 'Bearer tok')
  assert.equal(headers['x-turn-id'], 't1')
  assert.equal(headers['x-filename'], encodeURIComponent('résumé.txt'))
  assert.equal(headers['x-title'], encodeURIComponent('Résumé'))
  assert.equal(headers['content-length'], '3')

  const md = join(dir, 'plan.md')
  writeFileSync(md, '# Plan')
  await run({ command: 'canvas', path: md, title: 'Plan' }, { env, fetchImpl })
  assert.equal(calls[1].url, 'https://w.example/sandbox/canvas')
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { turnId: 't1', title: 'Plan', markdown: '# Plan' })
})

test('the tools say why when the Worker refuses, and refuse to run outside a turn', async () => {
  const env = { AGENT_API_URL: 'https://w.example', AGENT_TOOLS_TOKEN: 'tok', TURN_ID: 't1' }
  const dir = mkdtempSync(join(tmpdir(), 'tools-'))
  writeFileSync(join(dir, 'a.md'), 'x')
  const refuse = async () => Response.json({ ok: false, error: 'expired' }, { status: 401 })
  await assert.rejects(run({ command: 'canvas', path: join(dir, 'a.md'), title: 'A' }, { env, fetchImpl: refuse }), /refused: expired/)
  await assert.rejects(run({ command: 'canvas', path: join(dir, 'a.md'), title: 'A' }, { env: {}, fetchImpl: refuse }), /only work inside a turn/)
})
