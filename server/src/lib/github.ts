import { Octokit } from '@octokit/rest'
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { scoreStargazer } from './scoring';
import { HTTPException } from 'hono/http-exception';

// const StarspectOctokit = Octokit.plugin(throttling)

export async function fetchStargazers(owner: string, repo: string, token: string) {
  const octokit = new Octokit({
    auth: token
  })

  const data = await octokit.paginate("GET /repos/{owner}/{repo}/stargazers", { owner, repo }) as {
    login: string
  }[]

  return data.map(star => star.login)
}

export async function fetchUser(d1: D1Database, token: string, username: string) {
  const octokit = new Octokit({
    auth: token
  })

  const user = await octokit.request("GET /users/{username}", { username })
  /**
   * we do not make multiple requests for `/events` because if there is more activity
   * than the page can hold, the user is NOT fake.
   */
  const events = await octokit.paginate("GET /users/{username}/events", { username })
  const orgs = await octokit.paginate("GET /users/{username}/orgs", { username })

  if (user.status !== 200) {
    throw new HTTPException(user.status, { message: JSON.stringify(user.data, null, 2) })
  }

  const db = drizzle(d1, { schema })

  const insert = scoreStargazer({
    username,

    n_dates: new Set(events.map(event => new Date(event.created_at as string).toISOString().split('T')[0])).size,
    n_repos: new Set(events.map(event => event.repo?.name)).size,
    n_orgs: new Set(orgs.map(org => org.login)).size,

    total_actions: events.length,

    has_organization: orgs.length > 0,
    has_blog: user.data.blog !== null,
    has_company: user.data.company !== null,
    public_repos: user.data.public_repos,
    followers: user.data.followers,

    score: 1, // assume clean until proven otherwise

    account_created_at: new Date(user.data.created_at),

    checkedAt: new Date(),
  })

  db.insert(schema.stargazers).values(insert).onConflictDoUpdate({
    target: schema.stargazers.username,
    set: insert,
  }).execute() // does it really matter if I fail to insert? the operation will just run again next time, this is for caching purposes

  return insert
}

export async function fetchRepository(d1: D1Database, name: string, token: string) {
  const octokit = new Octokit({
    auth: token
  })

  const repository = await octokit.request("GET /repos/{owner}/{repo}", {
    owner: name.split('/')[0],
    repo: name.split('/')[1],
  })

  if (repository.status !== 200) {
    throw new HTTPException(repository.status, { message: JSON.stringify(repository.data, null, 2) })
  }

  return repository.data
}
