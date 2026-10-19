import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Miniflare } from 'miniflare'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { HTTPException } from 'hono/http-exception'
import * as schema from '../db/schema'
import { applyD1Migrations } from '../test-fixtures/apply-migrations'
import { encryptGitHubToken } from './tokens'
import { releaseUserGitHubToken, reserveUserGitHubToken } from './user-token'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sessionSecret = () => btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))

describe('reserveUserGitHubToken', () => {
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

    const tokenDb = drizzle(db, { schema })
    const secret = sessionSecret()
    const encrypted = await encryptGitHubToken('ghp_initial', secret, '1')
    await tokenDb.insert(schema.tokens).values({
      userId: '1',
      username: 'tester',
      token: encrypted,
      lastTokenUseAt: new Date(0),
      tokenUnusable: false,
    })
  })

  after(async () => {
    await mf.dispose()
  })

  it('releases by user id and reserved timestamp after login swaps ciphertext', async () => {
    const secret = sessionSecret()
    const tokenDb = drizzle(db, { schema })
    await tokenDb
      .update(schema.tokens)
      .set({ lastTokenUseAt: new Date(0), tokenUnusable: false })
      .where(eq(schema.tokens.userId, '1'))

    const reserved = await reserveUserGitHubToken(tokenDb, '1', secret)
    const rotated = await encryptGitHubToken('ghp_after_login', secret, '1')
    await tokenDb
      .update(schema.tokens)
      .set({ token: rotated })
      .where(eq(schema.tokens.userId, '1'))

    await releaseUserGitHubToken(tokenDb, reserved)

    const again = await reserveUserGitHubToken(tokenDb, '1', secret)
    assert.equal(again.plaintext, 'ghp_after_login')
  })

  it('allows exactly one concurrent reservation per user', async () => {
    const secret = sessionSecret()
    const tokenDb = drizzle(db, { schema })
    await tokenDb
      .update(schema.tokens)
      .set({ lastTokenUseAt: new Date(0), tokenUnusable: false })
      .where(eq(schema.tokens.userId, '1'))

    const first = reserveUserGitHubToken(tokenDb, '1', secret)
    const second = reserveUserGitHubToken(tokenDb, '1', secret)
    const results = await Promise.allSettled([first, second])

    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)

    const failure = rejected[0] as PromiseRejectedResult
    assert.ok(failure.reason instanceof HTTPException)
    assert.equal((failure.reason as HTTPException).status, 429)

    await releaseUserGitHubToken(tokenDb, (fulfilled[0] as PromiseFulfilledResult<Awaited<typeof first>>).value)
  })
})
