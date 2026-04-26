import { Context, Hono } from 'hono'
import type { AppBindings } from '../env'
import { deleteCookie, getCookie, setCookie, setSignedCookie } from 'hono/cookie'
import { drizzle } from 'drizzle-orm/d1'
import { sessionCookie, serializeSession } from '../auth/util'
import * as schema from '../db/schema'
import packageJson from '../../../package.json'

const scope = 'public_repo read:user'

const auth = new Hono<{ Bindings: AppBindings }>()

const oauthStateCookie = 'oauth_state'
const oauthCodeVerifierCookie = 'oauth_code_verifier'

const githubRestHeaders = (accessToken: string): Record<string, string> => ({
  Authorization: `Bearer ${accessToken}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': `starspect/${packageJson.version} (Cloudflare Worker; +https://github.com/kkrishguptaa/starspect)'`
})

const randomPkceVerifier = (): string => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

const redirectUri = (c: Context) => {
  const url = new URL(`${new URL(c.req.url).origin}/auth/callback`)
  const starAction = c.req.query('star_repository')
  starAction === 'true' ? url.searchParams.set('star_repository', starAction) : null
  return url.toString()
}

auth.get('/login', async (c) => {
  const url = new URL('https://github.com/login/oauth/authorize')

  const state = crypto.randomUUID()
  const codeVerifier = randomPkceVerifier()

  const encoder = new TextEncoder()
  const data = encoder.encode(codeVerifier)

  const hashBuffer = await crypto.subtle.digest('SHA-256', data)

  const base64 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  const codeChallenge = base64

  setCookie(c, oauthStateCookie, state, { httpOnly: true, secure: true })
  setCookie(c, oauthCodeVerifierCookie, codeVerifier, { httpOnly: true, secure: true })

  url.searchParams.set('client_id', c.env.CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri(c))
  url.searchParams.set('scope', scope)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')

  return c.redirect(url.toString())
})

auth.get('/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const codeVerifier = getCookie(c, oauthCodeVerifierCookie)
  const storedState = getCookie(c, oauthStateCookie)

  const starAction = c.req.query('star_repository')

  if (state !== storedState) {
    return c.json({ error: 'OAuth state mismatch' }, 400)
  }

  if (!codeVerifier) {
    return c.json({ error: 'OAuth code verifier not found' }, 400)
  }

  if (!code) {
    return c.json({ error: 'OAuth code not found' }, 400)
  }

  const body = new URLSearchParams({
    client_id: c.env.CLIENT_ID,
    client_secret: c.env.CLIENT_SECRET,
    code,
    redirect_uri: redirectUri(c),
    code_verifier: codeVerifier,
  })

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  const tokenPayload = (await response.json()) as {
    access_token?: string
    error?: string
    error_description?: string
  }

  if (!response.ok || !tokenPayload.access_token) {
    return c.json(
      {
        error: 'Failed to exchange code for token',
        details: tokenPayload.error_description ?? tokenPayload.error ?? response.statusText,
      },
      500,
    )
  }

  const { access_token } = tokenPayload

  const user = await fetch('https://api.github.com/user', {
    headers: githubRestHeaders(access_token),
  })

  if (!user.ok) {
    const body = await user.text()
    return c.json(
      { error: 'Failed to fetch user', details: body.slice(0, 300), status: user.status },
      500,
    )
  }

  const { id, login } = (await user.json()) as { id: number; login: string }

  const db = drizzle(c.env.db, { schema })

  await db.insert(schema.tokens).values({
    userId: String(id),
    username: login,
    token: access_token,
    lastTokenUseAt: new Date(),
  }).onConflictDoUpdate({
    target: schema.tokens.userId,
    set: {
      token: access_token,
      lastTokenUseAt: new Date(),
    },
  })

  if (starAction === 'true') {
    await fetch('https://api.github.com/user/starred/kkrishguptaa/starspect', {
      method: 'PUT',
      headers: githubRestHeaders(access_token),
    })
  }

  const sessionMaxAge = 60 * 60 * 24 * 14
  const exp = Math.floor(Date.now() / 1000) + sessionMaxAge
  await setSignedCookie(
    c,
    sessionCookie,
    serializeSession({ sub: String(id), login, exp }),
    c.env.SESSION_SECRET,
    {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: sessionMaxAge,
    },
  )

  deleteCookie(c, oauthStateCookie, { path: '/', secure: true, httpOnly: true })
  deleteCookie(c, oauthCodeVerifierCookie, { path: '/', secure: true, httpOnly: true })

  return c.redirect(`${new URL(c.req.url).origin}/auth/success`)
})

export { auth }
