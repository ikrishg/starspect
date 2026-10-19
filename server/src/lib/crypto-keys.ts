const SESSION_KEY_INFO = 'starspect-session-v1'
const TOKEN_KEY_INFO = 'starspect-github-token-v1'
const REQUIRED_SECRET_BYTES = 32

let validatedSecret: string | null = null
let sessionKeyPromise: Promise<CryptoKey> | null = null
let tokenKeyPromise: Promise<CryptoKey> | null = null

const decodeSecret = (secret: string) => {
  const bytes = Uint8Array.from(atob(secret), (character) => character.charCodeAt(0))
  if (bytes.length !== REQUIRED_SECRET_BYTES) {
    throw new Error(`SESSION_SECRET must be ${REQUIRED_SECRET_BYTES} bytes when base64-decoded`)
  }
  return bytes
}

export const ensureSessionSecret = (secret: string) => {
  if (validatedSecret === secret) {
    return
  }
  decodeSecret(secret)
  validatedSecret = secret
  sessionKeyPromise = null
  tokenKeyPromise = null
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
  sessionKeyPromise ??= deriveAesKey(secret, SESSION_KEY_INFO)
  return sessionKeyPromise
}

export const getTokenCryptoKey = (secret: string) => {
  tokenKeyPromise ??= deriveAesKey(secret, TOKEN_KEY_INFO)
  return tokenKeyPromise
}
