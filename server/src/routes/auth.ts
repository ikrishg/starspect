import { Context, Hono } from 'hono'
import type { AppBindings } from '../env'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema'
import packageJson from '../../../package.json'
import { encrypt, getSession } from '../lib/auth'
import { encryptGitHubToken, decryptGitHubToken } from '../lib/tokens'
import { putGitHubStar, STARSPECT_STAR_TARGET } from '../lib/github-star'

const scope = 'public_repo read:user'

const auth = new Hono<{ Bindings: AppBindings }>()

const oauthStateCookie = 'oauth_state'
const oauthCodeVerifierCookie = 'oauth_code_verifier'
export const starCsrfCookie = 'starspect_star_csrf'

const githubRestHeaders = (accessToken: string): Record<string, string> => ({
  Authorization: `Bearer ${accessToken}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': `starspect/${packageJson.version} (Cloudflare Worker; +https://github.com/ikrishg/starspect)`,
})

const randomPkceVerifier = (): string => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

const redirectUri = (c: Context) => `${new URL(c.req.url).origin}/auth/callback`

const issueStarCsrfToken = (c: Context) => {
  const csrf = crypto.randomUUID()
  setCookie(c, starCsrfCookie, csrf, {
    path: '/auth',
    secure: true,
    httpOnly: true,
    sameSite: 'Strict',
  })
  return csrf
}

const starConsentHtml = (csrf: string) => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Star Starspect on GitHub</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <main>
      <h1>Support Starspect</h1>
      <p>
        You are signed in. Starring
        <strong>${STARSPECT_STAR_TARGET.owner}/${STARSPECT_STAR_TARGET.repo}</strong>
        on GitHub is optional and only happens if you click below.
      </p>
      <form method="post" action="/auth/star">
        <input type="hidden" name="csrf" value="${csrf}" />
        <button type="submit">Star ${STARSPECT_STAR_TARGET.owner}/${STARSPECT_STAR_TARGET.repo} on GitHub</button>
      </form>
    </main>
  </body>
</html>`

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

auth.get('/star-consent', async (c) => {
  const session = await getSession(c)
  if (!session) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const csrf = getCookie(c, starCsrfCookie) ?? issueStarCsrfToken(c)
  return c.html(starConsentHtml(csrf))
})

auth.post('/star', async (c) => {
  const session = await getSession(c)
  if (!session) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const origin = c.req.header('Origin')
  const host = new URL(c.req.url).host
  if (origin) {
    const originHost = new URL(origin).host
    if (originHost !== host) {
      return c.json({ error: 'Forbidden' }, 403)
    }
  }

  const csrfCookie = getCookie(c, starCsrfCookie)
  const contentType = c.req.header('content-type')?.split(';')[0].trim().toLowerCase()
  let csrfBody: string | undefined

  if (contentType === 'application/json') {
    const body = (await c.req.json().catch(() => null)) as { csrf?: string } | null
    csrfBody = body?.csrf
  } else {
    const body = await c.req.parseBody()
    csrfBody = typeof body.csrf === 'string' ? body.csrf : undefined
  }

  if (!csrfCookie || !csrfBody || csrfCookie !== csrfBody) {
    return c.json({ error: 'Invalid CSRF token' }, 403)
  }

  const db = drizzle(c.env.db, { schema })
  const [tokenRow] = await db
    .select()
    .from(schema.tokens)
    .where(eq(schema.tokens.username, session.login))
    .execute()

  if (!tokenRow) {
    return c.json({ error: 'GitHub token not found for this account' }, 400)
  }

  const accessToken = await decryptGitHubToken(
    tokenRow.token,
    c.env.SESSION_SECRET,
    tokenRow.userId,
  )

  await putGitHubStar(accessToken)
  deleteCookie(c, starCsrfCookie, { path: '/auth', secure: true, httpOnly: true })

  return c.json({
    starred: true,
    repository: `${STARSPECT_STAR_TARGET.owner}/${STARSPECT_STAR_TARGET.repo}`,
  })
})

auth.get('/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const codeVerifier = getCookie(c, oauthCodeVerifierCookie)
  const storedState = getCookie(c, oauthStateCookie)

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
  const encryptedAccessToken = await encryptGitHubToken(
    access_token,
    c.env.SESSION_SECRET,
    String(id),
  )

  const [existingToken] = await db
    .select()
    .from(schema.tokens)
    .where(eq(schema.tokens.userId, String(id)))
    .execute()

  const tokenUpdate = {
    token: encryptedAccessToken,
    tokenUnusable: false,
    ...(existingToken?.tokenUnusable ? { lastTokenUseAt: new Date(0) } : {}),
  }

  await db.insert(schema.tokens).values({
    userId: String(id),
    username: login,
    token: encryptedAccessToken,
    lastTokenUseAt: existingToken?.lastTokenUseAt ?? new Date(0),
    tokenUnusable: false,
  }).onConflictDoUpdate({
    target: schema.tokens.userId,
    set: tokenUpdate,
  })

  const expiresAt = new Date(Date.now() /** one year */ + 1000 * 60 * 60 * 24 * 365).getTime()

  const tokenContent = [
    crypto.randomUUID(),
    login,
    expiresAt,
  ].join(':')

  const encrypted = await encrypt(tokenContent, c.env.SESSION_SECRET)
  const token = `${encrypted.iv}.${encrypted.data}`

  setCookie(c, 'starspect_session', token, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: Math.floor((expiresAt - Date.now()) / 1000),
  })

  issueStarCsrfToken(c)

  const sessionTtlSeconds = Math.max(60, Math.floor((expiresAt - Date.now()) / 1000))
  await c.env.sessions.put(token, expiresAt.toString(), { expirationTtl: sessionTtlSeconds })

  deleteCookie(c, oauthStateCookie, { path: '/', secure: true, httpOnly: true })
  deleteCookie(c, oauthCodeVerifierCookie, { path: '/', secure: true, httpOnly: true })

  return c.json({
    token: token,
    expiresAt: expiresAt,
    login: login,
    starConsentUrl: '/auth/star-consent',
  })
})

export { auth }
