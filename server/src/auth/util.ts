import { Context } from 'hono'
import { getCookie } from 'hono/cookie'

export const sessionCookie = 'starspect_session'

export type SessionPayload = {
  sub: string
  login: string
  exp: number
}

export const serializeSession = (p: SessionPayload): string => JSON.stringify(p)

export const parseSession = (raw: string | false | undefined): SessionPayload | null => {
  if (!raw || raw === 'false') return null
  try {
    const p = JSON.parse(raw) as SessionPayload
    if (typeof p.sub !== 'string' || typeof p.login !== 'string' || typeof p.exp !== 'number') {
      return null
    }
    if (p.exp < Math.floor(Date.now() / 1000)) return null
    return p
  } catch {
    return null
  }
}

export function isLoggedIn(c: Context) {
  const session = parseSession(getCookie(c, sessionCookie))
  return session !== null
}
