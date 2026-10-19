import { getStarCsrfHmacKey, STAR_CSRF_KEY_INFO } from './crypto-keys'

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
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
  new TextEncoder().encode(`${STAR_CSRF_KEY_INFO}:${sessionUuid}`)

export const STAR_CSRF_PATTERN = /^[A-Za-z0-9_-]{43}$/

export async function createStarCsrfToken(secret: string, sessionUuid: string) {
  const key = await getStarCsrfHmacKey(secret)
  const signature = await crypto.subtle.sign('HMAC', key, csrfPayload(sessionUuid))
  return toBase64Url(new Uint8Array(signature))
}

export async function verifyStarCsrfToken(secret: string, sessionUuid: string, token: string) {
  if (!STAR_CSRF_PATTERN.test(token)) {
    return false
  }

  try {
    const signatureBytes = fromBase64Url(token)
    if (toBase64Url(signatureBytes) !== token) {
      return false
    }

    const key = await getStarCsrfHmacKey(secret)
    return await crypto.subtle.verify('HMAC', key, signatureBytes, csrfPayload(sessionUuid))
  } catch {
    return false
  }
}
