import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Miniflare } from 'miniflare'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema'
import app from '../index'
import { applyD1Migrations } from '../test-fixtures/apply-migrations'
import { encrypt } from './auth'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sessionSecret = btoa(String.fromCharCode(...new Uint8Array(32).fill(11)))

const sessionKvBinding = (sessionKv: Map<string, string>): KVNamespace =>
  ({
    get: async (key: string) => sessionKv.get(key) ?? null,
    put: async (key: string, value: string) => {
      sessionKv.set(key, value)
    },
    delete: async (key: string) => {
      sessionKv.delete(key)
    },
  }) as unknown as KVNamespace

describe('POST /check', () => {
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

    const tokenDb = drizzle(db, { schema })
    await tokenDb.insert(schema.tokens).values({
      userId: '42',
      username: 'checker',
      token: 'ghp_plain',
      lastTokenUseAt: new Date(0),
      tokenUnusable: false,
    })
  })

  after(async () => {
    await mf.dispose()
  })

  beforeEach(async () => {
    const tokenDb = drizzle(db, { schema })
    await tokenDb
      .update(schema.tokens)
      .set({ lastTokenUseAt: new Date(0), tokenUnusable: false })
      .where(eq(schema.tokens.userId, '42'))
  })

  it('returns hint and clears session on GitHub 401', async () => {
    const expiresAt = Date.now() + 60_000
    const sessionUuid = crypto.randomUUID()
    const sessionPayload = await encrypt([sessionUuid, 'checker', '42', expiresAt].join(':'), sessionSecret)
    const sessionToken = `${sessionPayload.iv}.${sessionPayload.data}`
    sessionKv.set(sessionToken, String(expiresAt))

    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('api.github.com/repos/')) {
        return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })
      }
      return originalFetch(input)
    }

    try {
      const response = await app.fetch(
        new Request('https://example.com/check', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `starspect_session=${sessionToken}`,
          },
          body: JSON.stringify({ owner: 'octo', repo: 'repo' }),
        }),
        {
          db,
          sessions: sessionKvBinding(sessionKv),
          CLIENT_ID: 'x',
          CLIENT_SECRET: 'y',
          SESSION_SECRET: sessionSecret,
          CHECK_RATE_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
        },
      )

      assert.equal(response.status, 401)
      const body = (await response.json()) as { error?: string; hint?: string }
      assert.match(body.error ?? '', /sign in/i)
      assert.equal(body.hint, 'Sign in with GitHub again')
      assert.equal(sessionKv.has(sessionToken), false)

      const setCookie = response.headers.get('set-cookie') ?? ''
      assert.match(setCookie, /starspect_session=;/i)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns JSON 429 with hint when the user token is in cooldown', async () => {
    const tokenDb = drizzle(db, { schema })
    await tokenDb
      .update(schema.tokens)
      .set({ lastTokenUseAt: new Date() })
      .where(eq(schema.tokens.userId, '42'))

    const expiresAt = Date.now() + 60_000
    const sessionUuid = crypto.randomUUID()
    const sessionPayload = await encrypt([sessionUuid, 'checker', '42', expiresAt].join(':'), sessionSecret)
    const sessionToken = `${sessionPayload.iv}.${sessionPayload.data}`
    sessionKv.set(sessionToken, String(expiresAt))

    const response = await app.fetch(
      new Request('https://example.com/check', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `starspect_session=${sessionToken}`,
        },
        body: JSON.stringify({ owner: 'octo', repo: 'repo' }),
      }),
      {
        db,
        sessions: sessionKvBinding(sessionKv),
        CLIENT_ID: 'x',
        CLIENT_SECRET: 'y',
        SESSION_SECRET: sessionSecret,
        CHECK_RATE_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
      },
    )

    assert.equal(response.status, 429)
    const body = (await response.json()) as { error?: string; hint?: string }
    assert.match(body.error ?? '', /one-hour cooldown/i)
    assert.equal(body.hint, 'Try again after the one-hour cooldown')
  })
})
