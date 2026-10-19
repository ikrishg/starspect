import { ensureSessionSecret } from './crypto-keys'

const STAR_CSRF_SCOPE = 'starspect-star-csrf-v1'

const decodeSecret = (secret: string) => {
  ensureSessionSecret(secret)
  return Uint8Array.from(atob(secret), (character) => character.charCodeAt(0))
}

const hmacKey = (secret: string) =>
  crypto.subtle.importKey('raw', decodeSecret(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])

const toBase64Url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const fromBase64Url = (value: string) => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const padLength = (4 - (padded.length % 4)) % 4
  const base64 = padded + '='.repeat(padLength)
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
}

const csrfPayload = (sessionUuid: string) =>
  new TextEncoder().encode(`${STAR_CSRF_SCOPE}:${sessionUuid}`)

export const STAR_CSRF_PATTERN = /^[A-Za-z0-9_-]{43}$/

export async function createStarCsrfToken(secret: string, sessionUuid: string) {
  const key = await hmacKey(secret)
  const signature = await crypto.subtle.sign('HMAC', key, csrfPayload(sessionUuid))
  return toBase64Url(signature)
}

export async function verifyStarCsrfToken(secret: string, sessionUuid: string, token: string) {
  if (!STAR_CSRF_PATTERN.test(token)) {
    return false
  }

  try {
    const key = await hmacKey(secret)
    return crypto.subtle.verify('HMAC', key, fromBase64Url(token), csrfPayload(sessionUuid))
  } catch {
    return false
  }
}
