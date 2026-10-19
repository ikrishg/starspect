import { stargazers } from '../db/schema'

type StargazerInput = Omit<typeof stargazers.$inferSelect, 'score'>

export function scoreStargazer(user: StargazerInput): typeof stargazers.$inferSelect {
  const now = new Date()

  const accountAgeYears =
    (now.getTime() - new Date(user.account_created_at).getTime()) / (1000 * 60 * 60 * 24 * 365)

  const penalties =
    (user.n_dates <= 1 ? 0.20 : 0) +
    (user.n_repos <= 1 ? 0.15 : 0) +
    (user.n_orgs < 1 ? 0.10 : 0) +
    (user.total_actions < 2 ? 0.15 : 0) +
    (user.followers < 2 ? 0.10 : 0) +
    (!user.has_organization ? 0.05 : 0) +
    (!user.has_blog ? 0.05 : 0) +
    (!user.has_company ? 0.05 : 0) +
    (user.public_repos < 5 ? 0.10 : 0) +
    (accountAgeYears < 1 ? 0.05 : 0)

  return {
    ...user,
    score: Math.round((1 - penalties) * 100),
  }
}

const authenticityPercent = (score: number | null | undefined) => {
  if (score == null) {
    return 100
  }
  if (score <= 1) {
    return Math.round(score * 100)
  }
  return score
}

export function scoreRepository(users: Array<typeof stargazers.$inferSelect>) {
  const n_stars = users.length
  const n_fake_stars = users.filter((user) => authenticityPercent(user.score) < 50).length
  const n_low_activity = users.filter((user) => user.total_actions < 2).length
  const n_activity_cluster = users.filter((user) => user.n_dates <= 1).length

  const score =
    n_stars === 0
      ? 100
      : Math.round(
          users.reduce((sum, user) => sum + authenticityPercent(user.score), 0) / n_stars,
        )

  return {
    n_stars,
    n_fake_stars,
    n_low_activity,
    n_activity_cluster,
    score,
  }
}
