ALTER TABLE `tokens` ADD COLUMN `token_unusable` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `repositories` ADD COLUMN `n_scored_stars` integer;
--> statement-breakpoint
ALTER TABLE `repositories` ADD COLUMN `is_partial` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE `repository_skipped_stargazers` (
	`repository_id` text NOT NULL,
	`stargazer_username` text NOT NULL,
	`skipped_at` integer NOT NULL,
	PRIMARY KEY(`repository_id`, `stargazer_username`),
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `repository_stargazer_failures` (
	`repository_id` text NOT NULL,
	`stargazer_username` text NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_failed_at` integer NOT NULL,
	PRIMARY KEY(`repository_id`, `stargazer_username`),
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stargazers_to_repos_repository_id` ON `stargazers_to_repos` (`repository_id`);
