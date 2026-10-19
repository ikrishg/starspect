ALTER TABLE `tokens` ADD COLUMN `token_unusable` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `repositories` ADD COLUMN `n_scored_stars` integer;
--> statement-breakpoint
ALTER TABLE `repositories` ADD COLUMN `is_partial` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE `repository_skipped_stargazers` (
	`stargazer_username` text NOT NULL,
	`repository_id` text NOT NULL,
	PRIMARY KEY(`stargazer_username`, `repository_id`),
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`name`) ON UPDATE no action ON DELETE no action
);
