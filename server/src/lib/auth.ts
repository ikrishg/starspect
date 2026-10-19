import { Context } from 'hono'
import { deleteCookie, getCookie } from 'hono/cookie'
import { AppBindings } from '../env'
import { getSessionCryptoKey } from './crypto-keys'

export const encrypt = async (tokenContent: string, secret: string) => {
  const encoder = new TextEncoder()
  const key = await getSessionCryptoKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(tokenContent))

  return {
    iv: btoa(String.fromCharCode(...iv)),
    data: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
  }
}

export const decrypt = async (encrypted: Awaited<ReturnType<typeof encrypt>>, secret: string) => {
  const decoder = new TextDecoder()
  const key = await getSessionCryptoKey(secret)

  const iv = Uint8Array.from(atob(encrypted.iv), (character) => character.charCodeAt(0))
  const data = Uint8Array.from(atob(encrypted.data), (character) => character.charCodeAt(0))

  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data)

  return decoder.decode(decrypted)
}

export const getSession = async (c: Context<{ Bindings: AppBindings }>) => {
  const token =
    getCookie(c, 'starspect_session') || c.req.header('Authorization')?.split(' ')[1] || null

  if (!token) {
    return null
  }

  const separator = token.indexOf('.')
  if (separator === -1) {
    return null
  }

  const invalidateSession = async () => {
    await c.env.sessions.delete(token)
    deleteCookie(c, 'starspect_session')
  }

  try {
    const iv = token.slice(0, separator)
    const data = token.slice(separator + 1)
    const decrypted = await decrypt({ iv, data }, c.env.SESSION_SECRET)
    const parts = decrypted.split(':')
    if (parts.length !== 4) {
      if (parts.length === 3) {
        await invalidateSession()
      }
      return null
    }

    const [uuid, login, userId, expiresAt] = parts

    if (
      !uuid ||
      !login ||
      !userId ||
      !/^\d+$/.test(userId) ||
      !/^\d+$/.test(expiresAt) ||
      new Date(Number(expiresAt)) < new Date() ||
      (await c.env.sessions.get(token)) !== expiresAt
    ) {
      await invalidateSession()
      return null
    }

    return { uuid, login, userId, expiresAt: new Date(Number(expiresAt)) }
  } catch {
    return null
  }
}

export const clearSession = async (c: Context<{ Bindings: AppBindings }>) => {
  const token =
    getCookie(c, 'starspect_session') || c.req.header('Authorization')?.split(' ')[1] || null

  if (token) {
    await c.env.sessions.delete(token)
  }

  deleteCookie(c, 'starspect_session')
}

export const isLoggedIn = async (c: Context<{ Bindings: AppBindings }>) => {
  const session = await getSession(c)
  return session !== null
}
