/**
 * The token a sandbox uses to post its reply back to the Worker.
 *
 * The sandbox runs Claude on text anyone in the workspace can write, so treat everything in it as
 * readable by an attacker. That is why the Slack bot token never goes in: a leaked bot token posts
 * anywhere and reads everything. This token can do one thing: deliver the answer for ONE turn in
 * ONE thread, until it expires.
 *
 * Format: base64url(JSON claims) + "." + base64url(HMAC-SHA256(claims)).
 */
export interface CallbackClaims {
  channel: string
  threadTs: string
  turnId: string
  /** The newest message in the turn, whose status reaction the reply swaps. */
  lastTs: string
  /** Expiry, in ms since the epoch. */
  exp: number
}

export async function signCallbackToken(secret: string, claims: CallbackClaims): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(claims)))
  const sig = await hmac(secret, body)
  return `${body}.${b64url(sig)}`
}

export type VerifyResult = { ok: true; claims: CallbackClaims } | { ok: false; reason: string }

/** Checks the signature, the expiry, and that the token names the turn the caller says it is for. */
export async function verifyCallbackToken(
  secret: string,
  token: string | null | undefined,
  turnId: string,
  now = Date.now(),
): Promise<VerifyResult> {
  if (!token) return { ok: false, reason: 'missing token' }
  const [body, sig] = token.split('.')
  if (!body || !sig) return { ok: false, reason: 'malformed token' }

  const expected = await hmac(secret, body)
  if (!timingSafeEqual(expected, fromB64url(sig))) return { ok: false, reason: 'bad signature' }

  let claims: CallbackClaims
  try {
    claims = JSON.parse(new TextDecoder().decode(fromB64url(body)))
  } catch {
    return { ok: false, reason: 'malformed token' }
  }
  if (typeof claims.exp !== 'number' || claims.exp <= now) return { ok: false, reason: 'expired' }
  if (claims.turnId !== turnId) return { ok: false, reason: 'token is for another turn' }
  return { ok: true, claims }
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)))
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export function b64url(bytes: Uint8Array) {
  let s = ''
  for (const byte of bytes) s += String.fromCharCode(byte)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string) {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return new Uint8Array()
  }
}
