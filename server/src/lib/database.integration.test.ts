import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Miniflare } from 'miniflare'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema'
import { applyD1Migrations } from '../test-fixtures/apply-migrations'
import {
  clearStargazerFetchFailure,
  FULL_REPOSITORY_CACHE_MS,
  markStargazersSkipped,
  recordStargazerFetchFailure,
  STARGAZER_FAILURE_TTL_MS,
} from './database'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('database helpers', () => {
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
    await tokenDb.insert(schema.repositories).values({ name: 'batch/repo', isPartial: true })
  })

  after(async () => {
    await mf.dispose()
  })

  it('marks more than 33 skipped stargazers without exceeding D1 parameter limits', async () => {
    const tokenDb = drizzle(db, { schema })
    const repo = `batch-${crypto.randomUUID()}`
    await tokenDb.insert(schema.repositories).values({ name: repo, isPartial: true })
    const logins = Array.from({ length: 40 }, (_, index) => `skip-${index}`)

    await markStargazersSkipped(tokenDb, repo, ...logins)

    const rows = await tokenDb
      .select()
      .from(schema.repositorySkippedStargazers)
      .where(eq(schema.repositorySkippedStargazers.repositoryId, repo))
      .execute()
    assert.equal(rows.length, 40)
  })

  it('clears failure rows on success and expires counts after 24h', async () => {
    const tokenDb = drizzle(db, { schema })
    const repo = `fail-${crypto.randomUUID()}`
    await tokenDb.insert(schema.repositories).values({ name: repo, isPartial: true })

    const countOne = await recordStargazerFetchFailure(tokenDb, repo, 'retry-user')
    const countTwo = await recordStargazerFetchFailure(tokenDb, repo, 'retry-user')
    assert.equal(countOne, 1)
    assert.equal(countTwo, 2)

    await clearStargazerFetchFailure(tokenDb, repo, 'retry-user')
    const cleared = await tokenDb.select().from(schema.repositoryStargazerFailures).execute()
    assert.equal(cleared.length, 0)

    await recordStargazerFetchFailure(tokenDb, repo, 'stale-user')
    const staleAt = new Date(Date.now() - STARGAZER_FAILURE_TTL_MS - 60_000)
    await tokenDb
      .update(schema.repositoryStargazerFailures)
      .set({ lastFailedAt: staleAt, failureCount: 5 })
      .where(eq(schema.repositoryStargazerFailures.stargazerUsername, 'stale-user'))

    const refreshed = await recordStargazerFetchFailure(tokenDb, repo, 'stale-user')
    assert.equal(refreshed, 1)
  })
})

describe('fetchScoredStargazers freshness', () => {
  it('uses the same one-year window as fetchExistingUsers', () => {
    assert.equal(FULL_REPOSITORY_CACHE_MS, 1000 * 60 * 60 * 24 * 365)
  })
})
