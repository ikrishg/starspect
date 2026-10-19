import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema'
import { scoreStargazer } from './scoring'
import { HTTPException } from 'hono/http-exception'
import { RequestError } from '@octokit/request-error'
import { createOctokit } from './octokit'

export const STARGAZERS_PER_LIST_PAGE = 100
export const MAX_STARGAZERS_TO_LIST = 500
export const GITHUB_HTTP_CALLS_PER_USER = 3
// Workers invocations allow 50 subrequests on free; we budget below that for D1/KV/rate-limit overhead.
export const WORKER_SUBREQUEST_BUDGET = 48

export async function verifyRepositoryExists(owner: string, repo: string, token: string) {
  const octokit = createOctokit(token)

  try {
    await octokit.request('HEAD /repos/{owner}/{repo}', { owner, repo })
  } catch (error) {
    if (error instanceof RequestError && error.status === 404) {
      throw new HTTPException(404, { message: 'Repository not found' })
    }
    throw error
  }
}

export async function fetchStargazers(owner: string, repo: string, token: string) {
  const octokit = createOctokit(token)
  const logins: string[] = []

  await octokit.paginate(
    'GET /repos/{owner}/{repo}/stargazers',
    { owner, repo, per_page: STARGAZERS_PER_LIST_PAGE },
    (response, done) => {
      for (const stargazer of response.data as { login: string }[]) {
        if (logins.length >= MAX_STARGAZERS_TO_LIST) {
          done()
          return []
        }
        logins.push(stargazer.login)
      }

      if (logins.length >= MAX_STARGAZERS_TO_LIST) {
        done()
      }

      return []
    },
  )

  return logins
}

export async function fetchUser(d1: D1Database, token: string, username: string) {
  const octokit = createOctokit(token)

  try {
    const user = await octokit.request('GET /users/{username}', { username })
    const events = await octokit.request('GET /users/{username}/events', {
      username,
      per_page: 100,
    })
    const orgs = await octokit.request('GET /users/{username}/orgs', {
      username,
      per_page: 100,
    })

    const db = drizzle(d1, { schema })
    const blog = user.data.blog?.trim() ?? ''
    const eventItems = events.data

    const insert = scoreStargazer({
      username,
      n_dates: new Set(
        eventItems.map((event) => new Date(event.created_at as string).toISOString().split('T')[0]),
      ).size,
      n_repos: new Set(eventItems.map((event) => event.repo?.name)).size,
      n_orgs: new Set(orgs.data.map((org) => org.login)).size,
      total_actions: eventItems.length,
      has_organization: orgs.data.length > 0,
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
  } catch (error) {
    if (error instanceof RequestError && error.status === 404) {
      return null
    }
    throw error
  }
}
