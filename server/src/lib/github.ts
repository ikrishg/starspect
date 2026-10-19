import { Octokit } from '@octokit/rest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema'
import { scoreStargazer } from './scoring'
import { HTTPException } from 'hono/http-exception'

const MAX_STARGAZERS = 5_000

export async function fetchStargazers(owner: string, repo: string, token: string) {
  const octokit = new Octokit({ auth: token })

  const data = (await octokit.paginate('GET /repos/{owner}/{repo}/stargazers', {
    owner,
    repo,
    per_page: 100,
  })) as { login: string }[]

  return data.slice(0, MAX_STARGAZERS).map((star) => star.login)
}

export async function fetchUser(d1: D1Database, token: string, username: string) {
  const octokit = new Octokit({ auth: token })

  const user = await octokit.request('GET /users/{username}', { username })
  const events = await octokit.paginate('GET /users/{username}/events', { username, per_page: 100 })
  const orgs = await octokit.paginate('GET /users/{username}/orgs', { username, per_page: 100 })

  if (user.status !== 200) {
    throw new HTTPException(user.status, { message: JSON.stringify(user.data, null, 2) })
  }

  const db = drizzle(d1, { schema })
  const blog = user.data.blog?.trim() ?? ''

  const insert = scoreStargazer({
    username,
    n_dates: new Set(
      events.map((event) => new Date(event.created_at as string).toISOString().split('T')[0]),
    ).size,
    n_repos: new Set(events.map((event) => event.repo?.name)).size,
    n_orgs: new Set(orgs.map((org) => org.login)).size,
    total_actions: events.length,
    has_organization: orgs.length > 0,
    has_blog: blog.length > 0,
    has_company: user.data.company !== null,
    public_repos: user.data.public_repos,
    followers: user.data.followers,
    account_created_at: new Date(user.data.created_at),
    checkedAt: new Date(),
  })

  await db
    .insert(schema.stargazers)
    .values(insert)
    .onConflictDoUpdate({
      target: schema.stargazers.username,
      set: insert,
    })
    .execute()

  return insert
}
