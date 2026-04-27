ALTER TABLE `stargazers_to_repos` RENAME COLUMN `stargazer_id` TO `stargazer_username`;--> statement-breakpoint
ALTER TABLE `repositories` ADD `n_stars` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `n_fake_stars` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `n_low_activity` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `n_activity_cluster` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `score` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `checked_at` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `stargazers` ADD `default_avatar` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `stargazers` ADD `has_organization` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `stargazers` ADD `has_blog` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `stargazers` ADD `has_company` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `stargazers` ADD `public_repos` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `stargazers` ADD `followers` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `stargazers` ADD `score` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `stargazers` ADD `account_created_at` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `stargazers` ADD `checked_at` integer NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tokens` (
	`user_id` text PRIMARY KEY,
	`username` text NOT NULL UNIQUE,
	`github_token` text NOT NULL UNIQUE,
	`last_token_use_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_tokens`(`user_id`, `username`, `github_token`, `last_token_use_at`) SELECT `user_id`, `username`, `github_token`, `last_token_use_at` FROM `tokens`;--> statement-breakpoint
DROP TABLE `tokens`;--> statement-breakpoint
ALTER TABLE `__new_tokens` RENAME TO `tokens`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_stargazers_to_repos` (
	`stargazer_username` text NOT NULL,
	`repository_id` text NOT NULL,
	CONSTRAINT `stargazers_to_repos_pk` PRIMARY KEY(`stargazer_username`, `repository_id`),
	CONSTRAINT `fk_stargazers_to_repos_stargazer_username_stargazers_username_fk` FOREIGN KEY (`stargazer_username`) REFERENCES `stargazers`(`username`),
	CONSTRAINT `fk_stargazers_to_repos_repository_id_repositories_id_fk` FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_stargazers_to_repos`(`stargazer_username`, `repository_id`) SELECT `stargazer_username`, `repository_id` FROM `stargazers_to_repos`;--> statement-breakpoint
DROP TABLE `stargazers_to_repos`;--> statement-breakpoint
ALTER TABLE `__new_stargazers_to_repos` RENAME TO `stargazers_to_repos`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_stargazers` (
	`username` text PRIMARY KEY,
	`n_dates` integer NOT NULL,
	`n_repos` integer NOT NULL,
	`n_orgs` integer NOT NULL,
	`total_actions` integer NOT NULL,
	`default_avatar` integer NOT NULL,
	`has_organization` integer NOT NULL,
	`has_blog` integer NOT NULL,
	`has_company` integer NOT NULL,
	`public_repos` integer NOT NULL,
	`followers` integer NOT NULL,
	`score` integer NOT NULL,
	`account_created_at` integer NOT NULL,
	`checked_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_stargazers`(`username`, `n_dates`, `n_repos`, `n_orgs`, `total_actions`) SELECT `username`, `n_dates`, `n_repos`, `n_orgs`, `total_actions` FROM `stargazers`;--> statement-breakpoint
DROP TABLE `stargazers`;--> statement-breakpoint
ALTER TABLE `__new_stargazers` RENAME TO `stargazers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `repository_owner_repo_idx` ON `repositories` (`owner`,`repo`);