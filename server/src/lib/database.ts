import { drizzle } from "drizzle-orm/d1"
import * as schema from '../db/schema'
import { asc, and, inArray, lt, gt } from 'drizzle-orm'
import { eq } from "drizzle-orm"

export async function selectTokens(d1: D1Database, needed: number) {
  const db = drizzle(d1, { schema })

  const tokens = await db.select({
    token: schema.tokens.token
  })
    .from(schema.tokens)
    .orderBy(asc(schema.tokens.lastTokenUseAt))
    .where(lt(schema.tokens.lastTokenUseAt, new Date(Date.now() - /** one hour */ 1000 * 60 * 60)))
    .limit(needed)
    .execute()

  db.update(schema.tokens).set({
    lastTokenUseAt: new Date()
  }).where(inArray(schema.tokens.token, tokens.map((token) => token.token))).execute()

  return tokens.map((token) => token.token)
}

export async function fetchExistingUsers(d1: D1Database, ...usernames: string[]) {
  const db = drizzle(d1, { schema })

  const users = await db.select()
    .from(schema.stargazers)
    .where(
      and(
        inArray(schema.stargazers.username, usernames),
        /** if older than one year, don't return them */
        gt(schema.stargazers.checkedAt, new Date(Date.now() - /** 1 year */ 1000 * 60 * 60 * 24 * 365))
      )
    )
    .execute()

  return new Map(users.map((user) => [user.username, user]))
}

export async function fetchExistingRepository(d1: D1Database, name: string) {
  const db = drizzle(d1, { schema })

  const repository = await db.select()
    .from(schema.repositories)
    .where(and(
      gt(schema.repositories.checkedAt, new Date(Date.now() - /** 1 year */ 1000 * 60 * 60 * 24 * 365)),
      and(eq(schema.repositories.name, name))
    ))
    .execute()

  if (repository.length === 0) {
    await db.insert(schema.repositories).values({
      name,
    }).onConflictDoNothing().execute()

    return null
  }

  return repository
}

export async function createRepositoryRelation(d1: D1Database, name: string, ...usernames: string[]) {
  const db = drizzle(d1, { schema })

  await db.insert(schema.stargazersToRepos).values(usernames.map((username) => ({
    stargazerUsername: username,
    repositoryId: name,
  })))
  .onConflictDoNothing().execute()
}
