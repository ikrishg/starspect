CREATE TABLE `tokens` (
	`user_id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`github_token` text NOT NULL,
	`last_token_use_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_username_unique` ON `tokens` (`username`);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_github_token_unique` ON `tokens` (`github_token`);
--> statement-breakpoint
CREATE TABLE `repositories` (
	`name` text PRIMARY KEY NOT NULL,
	`n_stars` integer,
	`n_fake_stars` integer,
	`n_low_activity` integer,
	`n_activity_cluster` integer,
	`score` integer,
	`checked_at` integer
);
--> statement-breakpoint
CREATE TABLE `stargazers` (
	`username` text PRIMARY KEY NOT NULL,
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
	`checked_at` integer
);
--> statement-breakpoint
CREATE TABLE `stargazers_to_repos` (
	`stargazer_username` text NOT NULL,
	`repository_id` text NOT NULL,
	PRIMARY KEY(`stargazer_username`, `repository_id`),
	FOREIGN KEY (`stargazer_username`) REFERENCES `stargazers`(`username`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`name`) ON UPDATE no action ON DELETE no action
);
