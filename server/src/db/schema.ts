import { int, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { defineRelations } from 'drizzle-orm'

export const tokens = sqliteTable('tokens', {
  userId: text('user_id').primaryKey().notNull(),
  username: text('username').notNull().unique(),
  token: text('github_token').notNull().unique(),

  lastTokenUseAt: int('last_token_use_at', { mode: 'timestamp' }).notNull(),
})

export const repositories = sqliteTable('repositories', {
  name: text('name').primaryKey(),

  n_stars: int('n_stars'),
  n_fake_stars: int('n_fake_stars'),
  n_low_activity: int('n_low_activity'),
  n_activity_cluster: int('n_activity_cluster'),

  score: int('score'),

  checkedAt: int('checked_at', { mode: 'timestamp' }),
});

export const stargazers = sqliteTable('stargazers', {
  username: text('username').primaryKey(),

  n_dates: int('n_dates').notNull(), // Distinct active dates
  n_repos: int('n_repos').notNull(), // Distinct repos interacted with
  n_orgs: int('n_orgs').notNull(), // Distinct orgs interacted with

  total_actions: int('total_actions').notNull(), // Total lifetime actions

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
);

export const relations = defineRelations({ stargazers, repositories, stargazersToRepos },
  (r) => ({
    stargazers: {
      repositories: r.many.repositories({
        from: r.stargazers.username.through(r.stargazersToRepos.stargazerUsername),
        to: r.repositories.name.through(r.stargazersToRepos.repositoryId),
      }),
    },
    repositories: {
      stargazers: r.many.stargazers(),
    },
  })
);
