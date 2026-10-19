import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Miniflare } from 'miniflare'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema'
import { score, type ScoreGithubDeps } from './starscout'
import { scoreStargazer } from './scoring'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationStatements = readFileSync(join(__dirname, '../../drizzle/0000_schema.sql'), 'utf8')
  .split('--> statement-breakpoint')
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0)

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
    await db.exec('PRAGMA foreign_keys = ON')
    for (const statement of migrationStatements) {
      await db.prepare(statement).run()
    }

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

  it('persists repository row before relations on a fresh D1 database', async () => {
    const sessionSecret = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
    const testGithub: ScoreGithubDeps = {
      verifyRepositoryExists: async () => undefined,
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

    const result = await score(
      {
        db,
        sessions: {} as KVNamespace,
        CHECK_RATE_LIMITER: {} as RateLimit,
        CLIENT_ID: 'x',
        CLIENT_SECRET: 'y',
        SESSION_SECRET: sessionSecret,
      },
      'octo',
      'repo',
      testGithub,
    )

    assert.equal(result.name, 'octo/repo')
    assert.equal(result.n_stars, 1)
    assert.ok(result.score !== null)

    const relationDb = drizzle(db, { schema })
    const relations = await relationDb.select().from(schema.stargazersToRepos).execute()
    assert.equal(relations.length, 1)
    assert.equal(relations[0].repositoryId, 'octo/repo')
  })
})
