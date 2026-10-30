// I-5: the GitHub token is an installation token (1 hour, only the picked repos) with PR-only permissions.
import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { test } from 'node:test'
import { appJwt, mintInstallationToken, TOKEN_PERMISSIONS } from '../src/github.ts'

// GitHub hands out PKCS#1 keys; the code must accept that format as-is.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

test('signs a valid RS256 app JWT from a PKCS#1 key, with escaped newlines too', async () => {
  for (const pem of [privateKey, privateKey.replace(/\n/g, '\\n')]) {
    const jwt = await appJwt('12345', pem, 1_000_000)
    const [h, p, s] = jwt.split('.')
    const ok = verify('sha256', Buffer.from(`${h}.${p}`), createPublicKey(publicKey), Buffer.from(s, 'base64url'))
    assert.equal(ok, true)
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString())
    assert.equal(claims.iss, '12345')
    assert.ok(claims.exp - claims.iat <= 600, 'GitHub refuses a JWT that lives longer than 10 minutes')
  }
})

test('mints an installation token asking only for PR permissions', async () => {
  const calls: Array<{ url: string; body?: string }> = []
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body as string | undefined })
    if (url.endsWith('/app/installations')) return Response.json([{ id: 77 }])
    return Response.json({ token: 'ghs_test', expires_at: '2030-01-01T00:00:00Z' })
  }) as typeof fetch

  const env = { GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: privateKey } as never
  assert.equal(await mintInstallationToken(env, fakeFetch), 'ghs_test')
  assert.equal(calls[1].url, 'https://api.github.com/app/installations/77/access_tokens')
  assert.deepEqual(JSON.parse(calls[1].body!), { permissions: TOKEN_PERMISSIONS })
  assert.deepEqual(TOKEN_PERMISSIONS, { contents: 'write', pull_requests: 'write', metadata: 'read' })
})

test('refuses to guess between several installations', async () => {
  const fakeFetch = (async () => Response.json([{ id: 1 }, { id: 2 }])) as unknown as typeof fetch
  const env = { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey } as never
  await assert.rejects(mintInstallationToken(env, fakeFetch), /GITHUB_INSTALLATION_ID/)
})
