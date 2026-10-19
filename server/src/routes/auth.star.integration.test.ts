import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Miniflare } from 'miniflare'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema'
import { applyD1Migrations } from '../test-fixtures/apply-migrations'
import { auth } from './auth'
import { encryptGitHubToken } from '../lib/tokens'
import { decrypt, encrypt } from '../lib/auth'
import { createStarCsrfToken } from '../lib/star-csrf'
import { STARSPECT_STAR_TARGET } from '../lib/github-star'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sessionSecret = btoa(String.fromCharCode(...new Uint8Array(32).fill(4)))

const bindings = (db: D1Database, sessions: KVNamespace) => ({
  db,
  sessions,
  CLIENT_ID: 'client',
  CLIENT_SECRET: 'secret',
  SESSION_SECRET: sessionSecret,
  CHECK_RATE_LIMITER: {} as RateLimit,
})

const createSession = async (
  login: string,
  userId: string,
  sessionKv: Map<string, string>,
) => {
  const expiresAt = Date.now() + 60_000
  const sessionUuid = crypto.randomUUID()
  const sessionPayload = await encrypt(
    [sessionUuid, login, userId, expiresAt].join(':'),
    sessionSecret,
  )
  const sessionToken = `${sessionPayload.iv}.${sessionPayload.data}`
  sessionKv.set(sessionToken, String(expiresAt))
  return { sessionToken, sessionUuid, expiresAt }
}

const starPost = async (
  db: D1Database,
  sessionKv: Map<string, string>,
  options: {
    sessionToken: string
    sessionUuid: string
    origin?: string
    secFetchSite?: string
    csrf?: string
    includeCsrf?: boolean
    includeSession?: boolean
  },
) => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (options.origin !== undefined) {
    headers.Origin = options.origin
  }
  if (options.secFetchSite !== undefined) {
    headers['Sec-Fetch-Site'] = options.secFetchSite
  }
  if (options.includeSession !== false) {
    headers.Cookie = `starspect_session=${options.sessionToken}`
  }

  const body =
    options.includeCsrf === false
      ? JSON.stringify({})
      : JSON.stringify({
          csrf: options.csrf ?? (await createStarCsrfToken(sessionSecret, options.sessionUuid)),
        })

  return auth.fetch(
    new Request('https://example.com/star', {
      method: 'POST',
      headers,
      body,
    }),
    bindings(db, {
      get: async (key: string) => sessionKv.get(key) ?? null,
      put: async () => undefined,
    } as unknown as KVNamespace),
  )
}

describe('auth star consent', () => {
  let mf: Miniflare
  let db: D1Database
  let sessionKv: Map<string, string>

  before(async () => {
    mf = new Miniflare({
      modules: true,
      scriptPath: join(__dirname, '../test-fixtures/miniflare-empty.mjs'),
      d1Databases: ['DB'],
    })
    db = await mf.getD1Database('DB')
    await applyD1Migrations(db)
    sessionKv = new Map()
  })

  after(async () => {
    await mf.dispose()
    mock.restoreAll()
  })

  it('ignores star_repository on crafted login and callback URLs', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'ghp_oauth' }), { status: 200 })
      }
      if (url.includes('api.github.com/user') && !url.includes('/starred/')) {
        return new Response(JSON.stringify({ id: 99, login: 'victim' }), { status: 200 })
      }
      if (url.includes('/user/starred/')) {
        throw new Error('star API must not be called from OAuth callback')
      }
      return new Response('not found', { status: 404 })
    })

    const loginResponse = await auth.fetch(
      new Request('https://example.com/login?star_repository=true'),
      bindings(db, { get: async () => null, put: async () => undefined } as unknown as KVNamespace),
    )
    assert.equal(loginResponse.status, 302)
    const authorizeUrl = loginResponse.headers.get('location') ?? ''
    assert.ok(!authorizeUrl.includes('star_repository'))

    const callbackResponse = await auth.fetch(
      new Request(
        'https://example.com/callback?code=test-code&state=state-value&star_repository=true',
        {
          headers: {
            Cookie: 'oauth_state=state-value; oauth_code_verifier=verifier-value',
          },
        },
      ),
      bindings(db, {
        get: async () => null,
        put: async (key: string, value: string) => {
          sessionKv.set(key, value)
        },
      } as unknown as KVNamespace),
    )

    assert.equal(callbackResponse.status, 200)
    const payload = (await callbackResponse.json()) as { starConsentUrl?: string }
    assert.equal(payload.starConsentUrl, '/auth/star-consent')
    assert.equal(
      fetchMock.mock.calls.filter((call) => String(call.arguments[0]).includes('/user/starred/')).length,
      0,
    )
  })

  it('stars the repository only after an explicit consent POST', async () => {
    const encrypted = await encryptGitHubToken('ghp_consent', sessionSecret, '77')
    const tokenDb = drizzle(db, { schema })
    await tokenDb.insert(schema.tokens).values({
      userId: '77',
      username: 'consent-user',
      token: encrypted,
      lastTokenUseAt: new Date(0),
      tokenUnusable: false,
    })

    const { sessionToken, sessionUuid } = await createSession('consent-user', '77', sessionKv)
    let starCalls = 0

    mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes(`/user/starred/${STARSPECT_STAR_TARGET.owner}/${STARSPECT_STAR_TARGET.repo}`)) {
        assert.equal(init?.method, 'PUT')
        starCalls++
        return new Response(null, { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })

    const response = await starPost(db, sessionKv, {
      sessionToken,
      sessionUuid,
      origin: 'https://example.com',
    })

    assert.equal(response.status, 200)
    assert.equal(starCalls, 1)
    const body = (await response.json()) as { starred: boolean }
    assert.equal(body.starred, true)
  })

  it('selects the OAuth token by GitHub user id after a username takeover', async () => {
    const tokenDb = drizzle(db, { schema })
    const encryptedA = await encryptGitHubToken('ghp_account_a', sessionSecret, '100')
    const encryptedB = await encryptGitHubToken('ghp_account_b', sessionSecret, '200')

    await tokenDb.insert(schema.tokens).values({
      userId: '100',
      username: 'alice',
      token: encryptedA,
      lastTokenUseAt: new Date(0),
      tokenUnusable: false,
    })

    mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'ghp_account_b' }), { status: 200 })
      }
      if (url.includes('api.github.com/user') && !url.includes('/starred/')) {
        return new Response(JSON.stringify({ id: 200, login: 'alice' }), { status: 200 })
      }
      if (url.includes('/user/starred/')) {
        const authHeader = String(init?.headers && (init.headers as Record<string, string>).Authorization)
        assert.ok(authHeader.includes('ghp_account_b'))
        assert.ok(!authHeader.includes('ghp_account_a'))
        return new Response(null, { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })

    const callbackResponse = await auth.fetch(
      new Request('https://example.com/callback?code=takeover&state=state-value', {
        headers: {
          Cookie: 'oauth_state=state-value; oauth_code_verifier=verifier-value',
        },
      }),
      bindings(db, {
        get: async () => null,
        put: async (key: string, value: string) => {
          sessionKv.set(key, value)
        },
      } as unknown as KVNamespace),
    )
    assert.equal(callbackResponse.status, 200)

    const rows = await tokenDb.select().from(schema.tokens).execute()
    const accountA = rows.find((row) => row.userId === '100')
    const accountB = rows.find((row) => row.userId === '200')
    assert.equal(accountA?.username, '#100')
    assert.equal(accountB?.username, 'alice')

    const payload = (await callbackResponse.json()) as { token: string }
    const separator = payload.token.indexOf('.')
    const decryptedSession = await decrypt(
      {
        iv: payload.token.slice(0, separator),
        data: payload.token.slice(separator + 1),
      },
      sessionSecret,
    )
    const [sessionUuid] = decryptedSession.split(':')

    const starResponse = await starPost(db, sessionKv, {
      sessionToken: payload.token,
      sessionUuid,
      origin: 'https://example.com',
    })
    assert.equal(starResponse.status, 200)
  })

  it('rejects legacy three-part session tokens', async () => {
    const expiresAt = Date.now() + 60_000
    const legacy = await encrypt([crypto.randomUUID(), 'legacy-user', expiresAt].join(':'), sessionSecret)
    const legacyToken = `${legacy.iv}.${legacy.data}`
    sessionKv.set(legacyToken, String(expiresAt))

    const response = await starPost(db, sessionKv, {
      sessionToken: legacyToken,
      sessionUuid: crypto.randomUUID(),
      origin: 'https://example.com',
    })

    assert.equal(response.status, 401)
    assert.equal(sessionKv.has(legacyToken), false)
  })

  it('rejects star POST with invalid origin and CSRF combinations', async () => {
    const encrypted = await encryptGitHubToken('ghp_guard', sessionSecret, '88')
    const tokenDb = drizzle(db, { schema })
    await tokenDb.insert(schema.tokens).values({
      userId: '88',
      username: 'guard-user',
      token: encrypted,
      lastTokenUseAt: new Date(0),
      tokenUnusable: false,
    })

    const { sessionToken, sessionUuid } = await createSession('guard-user', '88', sessionKv)
    const validCsrf = await createStarCsrfToken(sessionSecret, sessionUuid)

    mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/user/starred/')) {
        return new Response(null, { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })

    const cases: Array<{ label: string; init: Parameters<typeof starPost>[2]; status: number }> = [
      {
        label: 'wrong origin host',
        init: { sessionToken, sessionUuid, origin: 'https://evil.example.com' },
        status: 403,
      },
      {
        label: 'http origin mismatch',
        init: { sessionToken, sessionUuid, origin: 'http://example.com' },
        status: 403,
      },
      {
        label: 'missing origin',
        init: { sessionToken, sessionUuid },
        status: 403,
      },
      {
        label: 'null origin',
        init: { sessionToken, sessionUuid, origin: 'null' },
        status: 403,
      },
      {
        label: 'missing csrf',
        init: {
          sessionToken,
          sessionUuid,
          origin: 'https://example.com',
          includeCsrf: false,
        },
        status: 403,
      },
      {
        label: 'malformed csrf',
        init: {
          sessionToken,
          sessionUuid,
          origin: 'https://example.com',
          csrf: 'not-a-valid-csrf-token',
        },
        status: 403,
      },
      {
        label: 'mismatched csrf',
        init: {
          sessionToken,
          sessionUuid,
          origin: 'https://example.com',
          csrf: (validCsrf.startsWith('a') ? 'b' : 'a') + validCsrf.slice(1),
        },
        status: 403,
      },
      {
        label: 'no session',
        init: { sessionToken, sessionUuid, origin: 'https://example.com', includeSession: false },
        status: 401,
      },
    ]

    for (const testCase of cases) {
      const response = await starPost(db, sessionKv, testCase.init)
      assert.equal(response.status, testCase.status, testCase.label)
    }

    const allowedWithoutOrigin = await starPost(db, sessionKv, {
      sessionToken,
      sessionUuid,
      secFetchSite: 'same-origin',
    })
    assert.equal(allowedWithoutOrigin.status, 200)
  })
})
