import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Miniflare } from 'miniflare'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema'
import { applyD1Migrations } from '../test-fixtures/apply-migrations'
import { finalizeReservedTokensOnError } from './token-errors'
import { RequestError } from '@octokit/request-error'
import { releaseReservedTokens } from './database'
import { encryptGitHubToken } from './tokens'
import { reserveUserGitHubToken } from './user-token'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sessionSecret = () => btoa(String.fromCharCode(...new Uint8Array(32).fill(2)))

describe('finalizeReservedTokensOnError', () => {
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

    const secret = sessionSecret()
    const tokenDb = drizzle(db, { schema })
    const encryptedOne = await encryptGitHubToken('ghp_one', secret, '401-a')
    const encryptedTwo = await encryptGitHubToken('ghp_two', secret, '401-b')
    await tokenDb.insert(schema.tokens).values([
      {
        userId: '401-a',
        username: 'token-a',
        token: encryptedOne,
        lastTokenUseAt: new Date(0),
        tokenUnusable: false,
      },
      {
        userId: '401-b',
        username: 'token-b',
        token: encryptedTwo,
        lastTokenUseAt: new Date(0),
        tokenUnusable: false,
      },
    ])
  })

  after(async () => {
    await mf.dispose()
  })

  it('releases cooldown on non-rate-limit 403', async () => {
    const secret = sessionSecret()
    const tokenDb = drizzle(db, { schema })
    await tokenDb
      .update(schema.tokens)
      .set({ lastTokenUseAt: new Date(0), tokenUnusable: false })
      .where(eq(schema.tokens.userId, '401-a'))

    const reserved = [await reserveUserGitHubToken(tokenDb, '401-a', secret)]
    const forbidden = new RequestError('blocked', 403, {
      request: { method: 'GET', url: 'https://api.github.com/repos/o/r', headers: {} },
      response: {
        status: 403,
        headers: {},
        url: '',
        data: { message: 'Repository access blocked' },
      },
    })

    await finalizeReservedTokensOnError(tokenDb, reserved, forbidden)

    const [row] = await tokenDb.select().from(schema.tokens).where(eq(schema.tokens.userId, reserved[0].userId))
    assert.equal(row.lastTokenUseAt?.getTime(), 0)
    assert.equal(row.tokenUnusable, false)
  })

  it('keeps cooldown on rate-limit 403', async () => {
    const secret = sessionSecret()
    const tokenDb = drizzle(db, { schema })
    await tokenDb
      .update(schema.tokens)
      .set({ lastTokenUseAt: new Date(0), tokenUnusable: false })
      .where(eq(schema.tokens.userId, '401-a'))

    const reserved = [await reserveUserGitHubToken(tokenDb, '401-a', secret)]
    const busyAt = reserved[0]
    const rateLimited = new RequestError('rate limit', 403, {
      request: { method: 'GET', url: 'https://api.github.com/users/x', headers: {} },
      response: {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' },
        url: '',
        data: {},
      },
    })

    await finalizeReservedTokensOnError(tokenDb, reserved, rateLimited)

    const [row] = await tokenDb
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.userId, busyAt.userId))
    assert.ok((row.lastTokenUseAt?.getTime() ?? 0) > 0)
    await releaseReservedTokens(tokenDb, reserved)
  })

  it('quarantines only the token that received 401', async () => {
    const secret = sessionSecret()
    const tokenDb = drizzle(db, { schema })
    await tokenDb
      .update(schema.tokens)
      .set({ lastTokenUseAt: new Date(0), tokenUnusable: false })
      .where(eq(schema.tokens.userId, '401-a'))
    await tokenDb
      .update(schema.tokens)
      .set({ lastTokenUseAt: new Date(0), tokenUnusable: false })
      .where(eq(schema.tokens.userId, '401-b'))

    const reserved = [
      await reserveUserGitHubToken(tokenDb, '401-a', secret),
      await reserveUserGitHubToken(tokenDb, '401-b', secret),
    ]

    const unauthorized = new RequestError('Bad credentials', 401, {
      request: { method: 'GET', url: 'https://api.github.com/users/x', headers: {} },
    })

    await finalizeReservedTokensOnError(tokenDb, reserved, unauthorized, reserved[0])

    const rows = await tokenDb.select().from(schema.tokens).execute()
    const first = rows.find((row) => row.userId === reserved[0].userId)
    const second = rows.find((row) => row.userId === reserved[1].userId)
    assert.equal(first?.tokenUnusable, true)
    assert.equal(second?.tokenUnusable, false)
    assert.equal(second?.lastTokenUseAt?.getTime(), 0)
  })

  it('releases cooldown when 401 quarantine misses after login swaps ciphertext', async () => {
    const secret = sessionSecret()
    const tokenDb = drizzle(db, { schema })
    await tokenDb
      .update(schema.tokens)
      .set({ lastTokenUseAt: new Date(0), tokenUnusable: false })
      .where(eq(schema.tokens.userId, '401-a'))

    const reserved = await reserveUserGitHubToken(tokenDb, '401-a', secret)
    const rotated = await encryptGitHubToken('ghp_after_login', secret, '401-a')
    await tokenDb
      .update(schema.tokens)
      .set({ token: rotated })
      .where(eq(schema.tokens.userId, '401-a'))

    const unauthorized = new RequestError('Bad credentials', 401, {
      request: { method: 'GET', url: 'https://api.github.com/users/x', headers: {} },
    })

    await finalizeReservedTokensOnError(tokenDb, [reserved], unauthorized, reserved)

    const again = await reserveUserGitHubToken(tokenDb, '401-a', secret)
    assert.equal(again.plaintext, 'ghp_after_login')
  })
})
