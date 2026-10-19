const SESSION_KEY_INFO = 'starspect-session-v1'
const TOKEN_KEY_INFO = 'starspect-github-token-v1'
export const STAR_CSRF_KEY_INFO = 'starspect-star-csrf-v1'
const REQUIRED_SECRET_BYTES = 32

const sessionKeyCache = new Map<string, Promise<CryptoKey>>()
const tokenKeyCache = new Map<string, Promise<CryptoKey>>()
const starCsrfKeyCache = new Map<string, Promise<CryptoKey>>()

const decodeSecret = (secret: string) => {
  const bytes = Uint8Array.from(atob(secret), (character) => character.charCodeAt(0))
  if (bytes.length !== REQUIRED_SECRET_BYTES) {
    throw new Error(`SESSION_SECRET must be ${REQUIRED_SECRET_BYTES} bytes when base64-decoded`)
  }
  return bytes
}

export const ensureSessionSecret = (secret: string) => {
  decodeSecret(secret)
}

const deriveAesKey = async (secret: string, info: string) => {
  ensureSessionSecret(secret)
  const master = decodeSecret(secret)
  const hkdfKey = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey'])

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: new TextEncoder().encode(info),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export const getSessionCryptoKey = (secret: string) => {
  let promise = sessionKeyCache.get(secret)
  if (!promise) {
    promise = deriveAesKey(secret, SESSION_KEY_INFO)
    sessionKeyCache.set(secret, promise)
  }
  return promise
}

export const getTokenCryptoKey = (secret: string) => {
  let promise = tokenKeyCache.get(secret)
  if (!promise) {
    promise = deriveAesKey(secret, TOKEN_KEY_INFO)
    tokenKeyCache.set(secret, promise)
  }
  return promise
}

const deriveHmacKey = async (secret: string, info: string) => {
  ensureSessionSecret(secret)
  const master = decodeSecret(secret)
  const hkdfKey = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey'])

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: new TextEncoder().encode(info),
    },
    hkdfKey,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  )
}

export const getStarCsrfHmacKey = (secret: string) => {
  let promise = starCsrfKeyCache.get(secret)
  if (!promise) {
    promise = deriveHmacKey(secret, STAR_CSRF_KEY_INFO)
    starCsrfKeyCache.set(secret, promise)
  }
  return promise
}
