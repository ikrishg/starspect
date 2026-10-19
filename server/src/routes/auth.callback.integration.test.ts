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

const __dirname = dirname(fileURLToPath(import.meta.url))
const sessionSecret = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))

describe('auth callback token refresh', () => {
  let mf: Miniflare
  let db: D1Database

  before(async () => {
    mf = new Miniflare({
      modules: true,
      scriptPath: join(__dirname, '../test-fixtures/miniflare-empty.mjs'),
      d1Databases: ['DB'],
    })
    db = await mf.getD1Database('DB')
    await applyD1Migrations(db)
  })

  after(async () => {
    await mf.dispose()
    mock.restoreAll()
  })

  it('does not reset lastTokenUseAt on re-login when the token was still usable', async () => {
    const secret = sessionSecret
    const encrypted = await encryptGitHubToken('ghp_busy', secret, '42')
    const busyAt = new Date(Date.now())

    const tokenDb = drizzle(db, { schema })
    await tokenDb.insert(schema.tokens).values({
      userId: '42',
      username: 'busy-user',
      token: encrypted,
      lastTokenUseAt: busyAt,
      tokenUnusable: false,
    })

    const fetchMock = mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'ghp_new' }), { status: 200 })
      }
      if (url.includes('api.github.com/user')) {
        return new Response(JSON.stringify({ id: 42, login: 'busy-user' }), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })

    const app = auth
    const response = await app.fetch(
      new Request(
        'https://example.com/callback?code=test-code&state=state-value&star_repository=false',
        {
          headers: {
            Cookie: 'oauth_state=state-value; oauth_code_verifier=verifier-value',
          },
        },
      ),
      {
        db,
        sessions: {
          put: async () => undefined,
        } as unknown as KVNamespace,
        CLIENT_ID: 'client',
        CLIENT_SECRET: 'secret',
        SESSION_SECRET: secret,
        CHECK_RATE_LIMITER: {} as RateLimit,
      },
    )

    assert.equal(response.status, 200)
    assert.equal(fetchMock.mock.callCount(), 2)

    const [row] = await tokenDb.select().from(schema.tokens).where(eq(schema.tokens.userId, '42'))
    assert.equal(row.tokenUnusable, false)
    assert.ok((row.lastTokenUseAt?.getTime() ?? 0) > 0)
    assert.ok(Math.abs((row.lastTokenUseAt?.getTime() ?? 0) - busyAt.getTime()) < 5_000)
  })
})
