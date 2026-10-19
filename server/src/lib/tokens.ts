import { getTokenCryptoKey } from './crypto-keys'

export const formatStoredGitHubToken = (iv: string, data: string) => `${iv}.${data}`

export const encryptGitHubToken = async (token: string, secret: string, userId: string) => {
  const encoder = new TextEncoder()
  const key = await getTokenCryptoKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(userId) },
    key,
    encoder.encode(token),
  )

  return formatStoredGitHubToken(
    btoa(String.fromCharCode(...iv)),
    btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
  )
}

export const decryptGitHubToken = async (stored: string, secret: string, userId: string) => {
  const separator = stored.indexOf('.')
  if (separator === -1) {
    return stored
  }

  const key = await getTokenCryptoKey(secret)
  const iv = Uint8Array.from(atob(stored.slice(0, separator)), (character) => character.charCodeAt(0))
  const data = Uint8Array.from(atob(stored.slice(separator + 1)), (character) => character.charCodeAt(0))

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(userId) },
    key,
    data,
  )

  return new TextDecoder().decode(decrypted)
}
