// R2 transcript backup: the key comes from the signed token claims only, one object per turn.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkTranscriptSize, MAX_TRANSCRIPT_BYTES, transcriptKey, transcriptPrefix } from '../src/transcripts.ts'

const claims = { channel: 'C1', threadTs: '111.222', turnId: 'turn-a', lastTs: '111.300' }

test('the key is the thread prefix plus the turn, so every turn writes a new object', () => {
  assert.equal(transcriptKey(claims), 'transcripts/C1/111.222/111.300-turn-a.jsonl.gz')
  assert.ok(transcriptKey(claims).startsWith(transcriptPrefix('C1', '111.222')))
  assert.notEqual(transcriptKey(claims), transcriptKey({ ...claims, turnId: 'turn-b', lastTs: '111.400' }))
})

test('refuses a missing, empty or oversized body before reading it', () => {
  assert.equal(checkTranscriptSize(null)?.status, 411)
  assert.equal(checkTranscriptSize('abc')?.status, 411)
  assert.equal(checkTranscriptSize('0')?.status, 400)
  assert.equal(checkTranscriptSize(String(MAX_TRANSCRIPT_BYTES + 1))?.status, 413)
  assert.equal(checkTranscriptSize('1234'), null)
})

test('the transcript door builds its key from the verified claims, never from the request', () => {
  const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts'), 'utf8')
  const door = index.slice(index.indexOf('async function sandboxTranscript'), index.indexOf('function stripMention'))
  assert.match(door, /verifyCallbackToken\(env\.CALLBACK_SECRET, token, turnId\)/)
  assert.match(door, /const key = transcriptKey\(claims\)/)
  assert.doesNotMatch(door, /\.delete\(/)
  assert.doesNotMatch(door, /searchParams|request\.json/)
})
