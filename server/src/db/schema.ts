import { int, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const tokens = sqliteTable('tokens', {
  userId: text('user_id').primaryKey().notNull(),
  username: text('username').notNull().unique(),
  token: text('github_token').notNull().unique(),
  lastTokenUseAt: int('last_token_use_at', { mode: 'timestamp' }).notNull(),
  tokenUnusable: int('token_unusable', { mode: 'boolean' }).notNull().default(false),
})

export const repositories = sqliteTable('repositories', {
  name: text('name').primaryKey(),
  n_stars: int('n_stars'),
  n_scored_stars: int('n_scored_stars'),
  n_fake_stars: int('n_fake_stars'),
  n_low_activity: int('n_low_activity'),
  n_activity_cluster: int('n_activity_cluster'),
  score: int('score'),
  isPartial: int('is_partial', { mode: 'boolean' }).notNull().default(false),
  checkedAt: int('checked_at', { mode: 'timestamp' }),
})

export const stargazers = sqliteTable('stargazers', {
  username: text('username').primaryKey(),
  n_dates: int('n_dates').notNull(),
  n_repos: int('n_repos').notNull(),
  n_orgs: int('n_orgs').notNull(),
  total_actions: int('total_actions').notNull(),
  has_organization: int('has_organization', { mode: 'boolean' }).notNull(),
  has_blog: int('has_blog', { mode: 'boolean' }).notNull(),
  has_company: int('has_company', { mode: 'boolean' }).notNull(),
  public_repos: int('public_repos').notNull(),
  followers: int('followers').notNull(),
  account_created_at: int('account_created_at', { mode: 'timestamp' }).notNull(),
  score: int('score'),
  checkedAt: int('checked_at', { mode: 'timestamp' }),
})

export const stargazersToRepos = sqliteTable(
  'stargazers_to_repos',
  {
    stargazerUsername: text('stargazer_username')
      .notNull()
      .references(() => stargazers.username),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.name),
  },
  (t) => [primaryKey({ columns: [t.stargazerUsername, t.repositoryId] })],
)
