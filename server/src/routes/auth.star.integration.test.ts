import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Miniflare } from 'miniflare'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema'
import { applyD1Migrations } from '../test-fixtures/apply-migrations'
import { auth, starCsrfCookie } from './auth'
import { encryptGitHubToken } from '../lib/tokens'
import { encrypt } from '../lib/auth'
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
    const secret = sessionSecret
    const encrypted = await encryptGitHubToken('ghp_consent', secret, '77')
    const tokenDb = drizzle(db, { schema })
    await tokenDb.insert(schema.tokens).values({
      userId: '77',
      username: 'consent-user',
      token: encrypted,
      lastTokenUseAt: new Date(0),
      tokenUnusable: false,
    })

    const expiresAt = Date.now() + 60_000
    const sessionPayload = await encrypt(
      [crypto.randomUUID(), 'consent-user', expiresAt].join(':'),
      secret,
    )
    const sessionToken = `${sessionPayload.iv}.${sessionPayload.data}`
    sessionKv.set(sessionToken, String(expiresAt))

    const csrf = 'csrf-test-token'
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

    const response = await auth.fetch(
      new Request('https://example.com/star', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://example.com',
          Cookie: `starspect_session=${sessionToken}; ${starCsrfCookie}=${csrf}`,
        },
        body: JSON.stringify({ csrf }),
      }),
      bindings(db, {
        get: async (key: string) => sessionKv.get(key) ?? null,
        put: async () => undefined,
      } as unknown as KVNamespace),
    )

    assert.equal(response.status, 200)
    assert.equal(starCalls, 1)
    const body = (await response.json()) as { starred: boolean }
    assert.equal(body.starred, true)
  })
})
