PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_repositories` (
	`id` text PRIMARY KEY,
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`n_stars` integer,
	`n_fake_stars` integer,
	`n_low_activity` integer,
	`n_activity_cluster` integer,
	`score` integer,
	`checked_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_repositories`(`id`, `owner`, `repo`, `n_stars`, `n_fake_stars`, `n_low_activity`, `n_activity_cluster`, `score`, `checked_at`) SELECT `id`, `owner`, `repo`, `n_stars`, `n_fake_stars`, `n_low_activity`, `n_activity_cluster`, `score`, `checked_at` FROM `repositories`;--> statement-breakpoint
DROP TABLE `repositories`;--> statement-breakpoint
ALTER TABLE `__new_repositories` RENAME TO `repositories`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_stargazers` (
	`username` text PRIMARY KEY,
	`n_dates` integer NOT NULL,
	`n_repos` integer NOT NULL,
	`n_orgs` integer NOT NULL,
	`total_actions` integer NOT NULL,
	`has_organization` integer NOT NULL,
	`has_blog` integer NOT NULL,
	`has_company` integer NOT NULL,
	`public_repos` integer NOT NULL,
	`followers` integer NOT NULL,
	`account_created_at` integer NOT NULL,
	`score` integer,
	`checked_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_stargazers`(`username`, `n_dates`, `n_repos`, `n_orgs`, `total_actions`, `has_organization`, `has_blog`, `has_company`, `public_repos`, `followers`, `score`, `account_created_at`, `checked_at`) SELECT `username`, `n_dates`, `n_repos`, `n_orgs`, `total_actions`, `has_organization`, `has_blog`, `has_company`, `public_repos`, `followers`, `score`, `account_created_at`, `checked_at` FROM `stargazers`;--> statement-breakpoint
DROP TABLE `stargazers`;--> statement-breakpoint
ALTER TABLE `__new_stargazers` RENAME TO `stargazers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `repository_owner_repo_idx` ON `repositories` (`owner`,`repo`);