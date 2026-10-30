import { b64url } from './callback-token.ts'
import type { Env } from './env.ts'

/**
 * GitHub App tokens for the sandbox.
 *
 * The token GitHub mints for an installation lasts 1 hour and reaches only the repos the student
 * picked when they installed the App. That is the whole reach of the bot on GitHub: no personal
 * token, nothing that outlives the turn by more than the hour.
 */
export function githubConfigured(env: Env) {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY)
}

/** Only what opening a PR needs. A token can never hold more than the App was granted. */
export const TOKEN_PERMISSIONS = { contents: 'write', pull_requests: 'write', metadata: 'read' } as const

export async function mintInstallationToken(env: Env, fetchImpl: typeof fetch = fetch): Promise<string> {
  const jwt = await appJwt(env.GITHUB_APP_ID!, env.GITHUB_APP_PRIVATE_KEY!)
  const headers = {
    authorization: `Bearer ${jwt}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'slack-agent-starter',
  }

  let installationId = env.GITHUB_INSTALLATION_ID
  if (!installationId) {
    const res = await fetchImpl('https://api.github.com/app/installations', { headers })
    if (!res.ok) throw new Error(`github installations: ${res.status} ${await res.text()}`)
    const list = (await res.json()) as Array<{ id: number }>
    if (list.length !== 1) {
      throw new Error(
        list.length
          ? `The GitHub App has ${list.length} installations. Set GITHUB_INSTALLATION_ID to pick one.`
          : 'The GitHub App is not installed on any account yet. Install it on the repos you want the bot to use.',
      )
    }
    installationId = String(list[0].id)
  }

  const res = await fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ permissions: TOKEN_PERMISSIONS }),
  })
  if (!res.ok) throw new Error(`github access token: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { token: string }).token
}

/** A 9-minute RS256 JWT that proves we are the App (GitHub allows 10). */
export async function appJwt(appId: string, pem: string, now = Math.floor(Date.now() / 1000)) {
  const enc = (o: object) => b64url(new TextEncoder().encode(JSON.stringify(o)))
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: now - 60, exp: now + 9 * 60, iss: appId })}`
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)))
  return `${unsigned}.${b64url(sig)}`
}

/**
 * GitHub hands out keys as PKCS#1 ("BEGIN RSA PRIVATE KEY"), and WebCrypto only imports PKCS#8.
 * PKCS#8 is the PKCS#1 key wrapped in a small header, so we add the header rather than ask every
 * student to run openssl.
 */
export function pemToPkcs8(pem: string): ArrayBuffer {
  // Secrets pasted through a dashboard sometimes arrive with literal "\n" instead of newlines.
  const text = pem.replace(/\\n/g, '\n')
  const der = Uint8Array.from(atob(text.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0))
  if (text.includes('BEGIN PRIVATE KEY')) return der.buffer
  if (!text.includes('BEGIN RSA PRIVATE KEY')) throw new Error('GITHUB_APP_PRIVATE_KEY is not a PEM private key')

  // SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { pkcs1 } }
  const version = [0x02, 0x01, 0x00]
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]
  const octet = [0x04, ...derLength(der.length), ...der]
  const body = [...version, ...algorithm, ...octet]
  return new Uint8Array([0x30, ...derLength(body.length), ...body]).buffer
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n]
  const bytes: number[] = []
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n >>= 8
  }
  return [0x80 | bytes.length, ...bytes]
}
