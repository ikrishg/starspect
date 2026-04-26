import { int, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { defineRelations } from 'drizzle-orm'

export const tokens = sqliteTable('tokens', {
  userId: text('user_id').primaryKey().notNull(),
  username: text('username').notNull().unique(),
  token: text('github_token').notNull().unique(),

  lastTokenUseAt: int('last_token_use_at', { mode: 'timestamp' }).notNull(),
})

export const repositories = sqliteTable('repositories', {
  id: text('id').primaryKey().notNull(),

  owner: text('owner').notNull(),
  repo: text('repo').notNull(),
})

export const stargazers = sqliteTable('stargazers', {
  id: text('id').primaryKey().notNull(),

  username: text('username').notNull().unique(),

  n_dates: int('n_dates').notNull(), // Distinct active dates
  n_repos: int('n_repos').notNull(), // Distinct repos interacted with
  n_orgs: int('n_orgs').notNull(), // Distinct orgs interacted with

  total_actions: int('total_actions').notNull(), // Total lifetime actions
})

export const stargazersToRepos = sqliteTable(
  'stargazers_to_repos',
  {
    stargazerId: int('stargazer_id')
      .notNull()
      .references(() => stargazers.id),
    repositoryId: int('repository_id')
      .notNull()
      .references(() => repositories.id),
  },
  (t) => [primaryKey({ columns: [t.stargazerId, t.repositoryId] })],
);

export const relations = defineRelations({ stargazers, repositories, stargazersToRepos },
  (r) => ({
    stargazers: {
      repositories: r.many.repositories({
        from: r.stargazers.id.through(r.stargazersToRepos.stargazerId),
        to: r.repositories.id.through(r.stargazersToRepos.repositoryId),
      }),
    },
    repositories: {
      stargazers: r.many.stargazers(),
    },
  })
);
