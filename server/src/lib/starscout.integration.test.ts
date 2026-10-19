import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Miniflare } from 'miniflare'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema'
import { score, type ScoreGithubDeps } from './starscout'
import { scoreStargazer } from './scoring'
import { applyD1Migrations } from '../test-fixtures/apply-migrations'
import { HTTPException } from 'hono/http-exception'
import { RequestError } from '@octokit/request-error'
import { encryptGitHubToken } from './tokens'
import {
  FULL_REPOSITORY_CACHE_MS,
  MAX_STARGAZER_FETCH_FAILURES,
  releaseReservedTokens,
  selectTokens,
} from './database'

const __dirname = dirname(fileURLToPath(import.meta.url))

const sampleUser = scoreStargazer({
  username: 'alice',
  n_dates: 5,
  n_repos: 3,
  n_orgs: 1,
  total_actions: 20,
  has_organization: true,
  has_blog: true,
  has_company: true,
  public_repos: 10,
  followers: 5,
  account_created_at: new Date('2020-01-01'),
  checkedAt: new Date(),
})

const sessionSecret = () => btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))

const testEnv = (db: D1Database) => ({
  db,
  sessions: {} as KVNamespace,
  CHECK_RATE_LIMITER: {} as RateLimit,
  CLIENT_ID: 'x',
  CLIENT_SECRET: 'y',
  SESSION_SECRET: sessionSecret(),
})

describe('score() integration', () => {
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
    await tokenDb.insert(schema.tokens).values({
      userId: '1',
      username: 'tester',
      token: 'ghp_test_plaintext',
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
      .where(eq(schema.tokens.userId, '1'))
  })

  it('persists repository row before relations on a fresh D1 database', async () => {
    const testGithub: ScoreGithubDeps = {
      fetchRepositoryMetadata: async () => ({ stargazers_count: 1 }),
      fetchStargazers: async () => ['alice'],
      fetchUser: async (d1, _token, username) => {
        if (username !== 'alice') {
          return null
        }
        const userDb = drizzle(d1, { schema })
        await userDb.insert(schema.stargazers).values(sampleUser).onConflictDoUpdate({
          target: schema.stargazers.username,
          set: sampleUser,
        })
        return sampleUser
      },
    }

    const result = await score(testEnv(db), 'octo', 'repo', testGithub)

    assert.equal(result.name, 'octo/repo')
    assert.equal(result.n_stars, 1)
    assert.equal(result.isPartial, false)
    assert.ok(result.score !== null)

    const relationDb = drizzle(db, { schema })
    const relations = await relationDb.select().from(schema.stargazersToRepos).execute()
    assert.equal(relations.length, 1)
    assert.equal(relations[0].repositoryId, 'octo/repo')
  })

  it('caches zero-star repositories as complete', async () => {
    const testGithub: ScoreGithubDeps = {
      fetchRepositoryMetadata: async () => ({ stargazers_count: 0 }),
      fetchStargazers: async () => {
        throw new Error('should not list stargazers for empty repo')
      },
      fetchUser: async () => null,
    }

    const result = await score(testEnv(db), 'empty', 'repo', testGithub)
    assert.equal(result.n_stars, 0)
    assert.equal(result.score, 0)
    assert.equal(result.isPartial, false)
  })

  it('resumes partial scoring across requests', async () => {
    const logins = Array.from({ length: 11 }, (_, index) => `fan${index}`)
    const testGithub: ScoreGithubDeps = {
      fetchRepositoryMetadata: async () => ({ stargazers_count: 11 }),
      fetchStargazers: async () => logins,
      fetchUser: async (d1, _token, username) => {
        const userDb = drizzle(d1, { schema })
        const user = { ...sampleUser, username }
        await userDb.insert(schema.stargazers).values(user).onConflictDoUpdate({
          target: schema.stargazers.username,
          set: user,
        })
        return user
      },
    }

    const env = testEnv(db)
    const first = await score(env, 'big', 'repo', testGithub)
    assert.equal(first.isPartial, true)
    assert.equal(first.n_scored_stars, 10)

    const tokenDb = drizzle(db, { schema })
    await tokenDb
      .update(schema.tokens)
      .set({ lastTokenUseAt: new Date(0) })
      .where(eq(schema.tokens.userId, '1'))

    const second = await score(env, 'big', 'repo', testGithub)
    assert.equal(second.isPartial, false)
    assert.equal(second.n_scored_stars, 11)
    assert.equal(second.n_stars, 11)
  })

  it('marks 404 stargazers skipped and completes the sample', async () => {
    const testGithub: ScoreGithubDeps = {
      fetchRepositoryMetadata: async () => ({ stargazers_count: 2 }),
      fetchStargazers: async () => ['ghost', 'alice'],
      fetchUser: async (d1, _token, username) => {
        if (username === 'ghost') {
          return null
        }
        const userDb = drizzle(db, { schema })
        await userDb.insert(schema.stargazers).values(sampleUser).onConflictDoUpdate({
          target: schema.stargazers.username,
          set: sampleUser,
        })
        return sampleUser
      },
    }

    const env = testEnv(db)
    const first = await score(env, 'skip', 'repo', testGithub)
    assert.equal(first.isPartial, false)
    assert.equal(first.n_stars, 2)

    const second = await score(env, 'skip', 'repo', testGithub)
    assert.equal(second.isPartial, false)
    assert.equal(second.n_stars, 2)

    const skippedDb = drizzle(db, { schema })
    const skipped = await skippedDb.select().from(schema.repositorySkippedStargazers).execute()
    assert.ok(skipped.some((row) => row.stargazerUsername === 'ghost'))
  })

  it('releases reserved tokens when scoring fails', async () => {
    const secret = sessionSecret()
    const tokenDb = drizzle(db, { schema })
    await tokenDb
      .update(schema.tokens)
      .set({ lastTokenUseAt: new Date(0) })
      .where(eq(schema.tokens.userId, '1'))

    const testGithub: ScoreGithubDeps = {
      fetchRepositoryMetadata: async () => {
        throw new HTTPException(500, { message: 'boom' })
      },
      fetchStargazers: async () => [],
      fetchUser: async () => null,
    }

    await assert.rejects(() => score({ ...testEnv(db), SESSION_SECRET: secret }, 'err', 'repo', testGithub))

    const [tokenRow] = await tokenDb.select().from(schema.tokens).where(eq(schema.tokens.userId, '1'))
    assert.equal(tokenRow.lastTokenUseAt?.getTime(), 0)
  })

  it('quarantines bad tokens and still reserves healthy ones', async () => {
    const secret = sessionSecret()
    const tokenDb = drizzle(db, { schema })
    await tokenDb.insert(schema.tokens).values({
      userId: '2',
      username: 'broken',
      token: 'not-valid-ciphertext.iv.data',
      lastTokenUseAt: new Date(0),
      tokenUnusable: false,
    })

    const reserved = await selectTokens(tokenDb, 2, secret)
    assert.equal(reserved.length, 1)
    assert.equal(reserved[0].userId, '1')

    const rows = await tokenDb.select().from(schema.tokens).execute()
    const broken = rows.find((row) => row.userId === '2')
    assert.equal(broken?.tokenUnusable, true)

    await releaseReservedTokens(tokenDb, reserved)
  })

  it('remembers skipped stargazers after the partial cache expires', async () => {
    const suffix = crypto.randomUUID()
    const ghosts = Array.from({ length: 10 }, (_, index) => `ghost${index}-${suffix}`)
    const alice = `alice-${suffix}`
    const logins = [...ghosts, alice]
    const testGithub: ScoreGithubDeps = {
      fetchRepositoryMetadata: async () => ({ stargazers_count: logins.length }),
      fetchStargazers: async () => logins,
      fetchUser: async (d1, _token, username) => {
        if (username !== alice) {
          return null
        }
        const userDb = drizzle(d1, { schema })
        const user = { ...sampleUser, username }
        await userDb.insert(schema.stargazers).values(user).onConflictDoUpdate({
          target: schema.stargazers.username,
          set: user,
        })
        return user
      },
    }

    const repoSlug = `stale-${crypto.randomUUID()}`
    const env = testEnv(db)
    const roundOne = await score(env, 'stale', repoSlug, testGithub)
    assert.equal(roundOne.isPartial, true)

    const tokenDb = drizzle(db, { schema })
    await tokenDb
      .update(schema.tokens)
      .set({ lastTokenUseAt: new Date(0) })
      .where(eq(schema.tokens.userId, '1'))
    await tokenDb
      .update(schema.repositories)
      .set({ checkedAt: new Date(Date.now() - 2.1 * 60 * 60 * 1000) })
      .where(eq(schema.repositories.name, `stale/${repoSlug}`))

    const roundTwo = await score(env, 'stale', repoSlug, testGithub)
    assert.equal(roundTwo.isPartial, false)
    assert.equal(roundTwo.n_scored_stars, 1)

    await tokenDb
      .update(schema.tokens)
      .set({ lastTokenUseAt: new Date(0) })
      .where(eq(schema.tokens.userId, '1'))
    await tokenDb
      .update(schema.repositories)
      .set({ checkedAt: new Date(Date.now() - 2.1 * 60 * 60 * 1000) })
      .where(eq(schema.repositories.name, `stale/${repoSlug}`))

    const roundThree = await score(env, 'stale', repoSlug, testGithub)
    assert.equal(roundThree.isPartial, false)
    assert.equal(roundThree.n_scored_stars, 1)
  })

  it('quarantines revoked tokens on 401 instead of releasing them', async () => {
    const secret = sessionSecret()
    const tokenDb = drizzle(db, { schema })
    const testGithub: ScoreGithubDeps = {
      fetchRepositoryMetadata: async () => {
        throw new RequestError('Bad credentials', 401, {
          request: { method: 'GET', url: 'https://api.github.com/repos/o/r', headers: {} },
        })
      },
      fetchStargazers: async () => [],
      fetchUser: async () => null,
    }

    await assert.rejects(() => score({ ...testEnv(db), SESSION_SECRET: secret }, 'revoked', 'repo', testGithub))

    const [row] = await tokenDb.select().from(schema.tokens).where(eq(schema.tokens.userId, '1'))
    assert.equal(row.tokenUnusable, true)
    assert.notEqual(row.lastTokenUseAt?.getTime(), 0)
  })

  it('marks repeatedly failing stargazers as skipped', async () => {
    const failing = Array.from({ length: 10 }, (_, index) => `fail${index}`)
    const testGithub: ScoreGithubDeps = {
      fetchRepositoryMetadata: async () => ({ stargazers_count: failing.length }),
      fetchStargazers: async () => failing,
      fetchUser: async () => {
        throw new RequestError('server blew up', 500, {
          request: { method: 'GET', url: 'https://api.github.com/users/x', headers: {} },
        })
      },
    }

    const env = testEnv(db)
    const failureRepo = `failures-${crypto.randomUUID()}`
    for (let round = 0; round < MAX_STARGAZER_FETCH_FAILURES; round++) {
      const tokenDb = drizzle(db, { schema })
      await tokenDb
        .update(schema.tokens)
        .set({ lastTokenUseAt: new Date(0) })
        .where(eq(schema.tokens.userId, '1'))
      const result = await score(env, 'failures', failureRepo, testGithub)
      if (round < MAX_STARGAZER_FETCH_FAILURES - 1) {
        assert.equal(result.isPartial, true)
      }
    }

    const tokenDb = drizzle(db, { schema })
    await tokenDb
      .update(schema.tokens)
      .set({ lastTokenUseAt: new Date(0) })
      .where(eq(schema.tokens.userId, '1'))
    const finalResult = await score(env, 'failures', failureRepo, testGithub)
    assert.equal(finalResult.isPartial, false)
    assert.equal(finalResult.n_scored_stars, 0)
  })

  it('marks repos with stars but an empty sample as partial', async () => {
    const testGithub: ScoreGithubDeps = {
      fetchRepositoryMetadata: async () => ({ stargazers_count: 3 }),
      fetchStargazers: async () => [],
      fetchUser: async () => null,
    }

    const result = await score(testEnv(db), 'hidden', 'stars', testGithub)
    assert.equal(result.isPartial, true)
    assert.equal(result.n_stars, 3)
  })

  it('refreshes stale linked stargazers after the repository cache expires', async () => {
    const repoSlug = `refresh-${crypto.randomUUID()}`
    let fetchCalls = 0
    const testGithub: ScoreGithubDeps = {
      fetchRepositoryMetadata: async () => ({ stargazers_count: 1 }),
      fetchStargazers: async () => ['stale-alice'],
      fetchUser: async (d1, _token, username) => {
        fetchCalls++
        const userDb = drizzle(d1, { schema })
        const user = { ...sampleUser, username, checkedAt: new Date() }
        await userDb.insert(schema.stargazers).values(user).onConflictDoUpdate({
          target: schema.stargazers.username,
          set: user,
        })
        return user
      },
    }

    const env = testEnv(db)
    await score(env, 'refresh', repoSlug, testGithub)
    assert.equal(fetchCalls, 1)

    const tokenDb = drizzle(db, { schema })
    await tokenDb
      .update(schema.stargazers)
      .set({ checkedAt: new Date(Date.now() - FULL_REPOSITORY_CACHE_MS - 86_400_000) })
      .where(eq(schema.stargazers.username, 'stale-alice'))
    await tokenDb
      .update(schema.repositories)
      .set({
        checkedAt: new Date(Date.now() - FULL_REPOSITORY_CACHE_MS - 86_400_000),
        isPartial: false,
      })
      .where(eq(schema.repositories.name, `refresh/${repoSlug}`))

    await tokenDb
      .update(schema.tokens)
      .set({ lastTokenUseAt: new Date(0) })
      .where(eq(schema.tokens.userId, '1'))

    await score(env, 'refresh', repoSlug, testGithub)
    assert.equal(fetchCalls, 2)
  })

  it('does not count rate limits toward stargazer skip failures', async () => {
    const repoSlug = `throttle-${crypto.randomUUID()}`
    const logins = ['throttle-a', 'throttle-b', 'throttle-c', 'still-valid']
    const rateLimitError = new RequestError('rate limit', 403, {
      request: { method: 'GET', url: 'https://api.github.com/users/x', headers: {} },
      response: {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' },
        url: '',
        data: { message: 'API rate limit exceeded' },
      },
    })

    const testGithub: ScoreGithubDeps = {
      fetchRepositoryMetadata: async () => ({ stargazers_count: logins.length }),
      fetchStargazers: async () => logins,
      fetchUser: async (d1, _token, username) => {
        if (username.startsWith('throttle')) {
          throw rateLimitError
        }
        const userDb = drizzle(d1, { schema })
        const user = { ...sampleUser, username }
        await userDb.insert(schema.stargazers).values(user).onConflictDoUpdate({
          target: schema.stargazers.username,
          set: user,
        })
        return user
      },
    }

    const env = testEnv(db)
    const result = await score(env, 'throttle', repoSlug, testGithub)
    assert.equal(result.isPartial, true)

    const tokenDb = drizzle(db, { schema })
    const failures = await tokenDb
      .select()
      .from(schema.repositoryStargazerFailures)
      .where(eq(schema.repositoryStargazerFailures.repositoryId, `throttle/${repoSlug}`))
      .execute()
    assert.equal(failures.length, 0)

    const skipped = await tokenDb
      .select()
      .from(schema.repositorySkippedStargazers)
      .where(eq(schema.repositorySkippedStargazers.repositoryId, `throttle/${repoSlug}`))
      .execute()
    assert.ok(!skipped.some((row) => row.stargazerUsername === 'still-valid'))
  })

  it('recovers quarantined tokens after re-login style reset', async () => {
    const secret = sessionSecret()
    const tokenDb = drizzle(db, { schema })
    const encrypted = await encryptGitHubToken('ghp_recovered', secret, '3')

    await tokenDb
      .update(schema.tokens)
      .set({ lastTokenUseAt: new Date(Date.now()) })
      .where(eq(schema.tokens.userId, '1'))

    await tokenDb.insert(schema.tokens).values({
      userId: '3',
      username: 'recovered',
      token: encrypted,
      lastTokenUseAt: new Date(0),
      tokenUnusable: true,
    })

    await tokenDb
      .update(schema.tokens)
      .set({
        token: encrypted,
        tokenUnusable: false,
        lastTokenUseAt: new Date(0),
      })
      .where(eq(schema.tokens.userId, '3'))

    const reserved = await selectTokens(tokenDb, 1, secret)
    assert.equal(reserved.length, 1)
    assert.equal(reserved[0].userId, '3')
    await releaseReservedTokens(tokenDb, reserved)
  })
})
