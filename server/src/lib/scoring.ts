import { stargazers } from "../db/schema"

export function scoreStargazer(user: Exclude<typeof stargazers.$inferSelect, 'score'>): typeof stargazers.$inferSelect {
  const now = new Date()

  const accountAgeYears = (now.getTime() - new Date(user.account_created_at).getTime()) / (1000 * 60 * 60 * 24 * 365)

  const penalties =
    (user.n_dates < 1       ? 0.20 : 0) + // Your activity should not be concentrated in a single day
    (user.n_repos <= 1      ? 0.15 : 0) + // You should have more than 1 repo interacted with
    (user.n_orgs < 1        ? 0.10 : 0) + // You should have more than 1 org interacted with
    (user.total_actions < 2 ? 0.15 : 0) + // You should have more than 2 actions
    (user.followers < 2     ? 0.10 : 0) + // You should have more than 2 followers
    (!user.has_organization ? 0.05 : 0) + // You should have at least one organization
    (!user.has_blog         ? 0.05 : 0) + // You should have a website url set on your github profile
    (!user.has_company      ? 0.05 : 0) + // You should have a company set on your github profile
    (user.public_repos < 5  ? 0.10 : 0) + // You should have at least 5 public repos
    (accountAgeYears < 1    ? 0.05 : 0) // You should be at least 1 year old account on github

  // score = 1 means clean, score = 0 means fully fake
  return {
    ...user,
    score: 1 - penalties,
  }
}
