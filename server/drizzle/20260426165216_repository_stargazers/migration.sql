CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`repo` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stargazers` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`n_dates` integer NOT NULL,
	`n_repos` integer NOT NULL,
	`n_orgs` integer NOT NULL,
	`total_actions` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `repository_stargazers` (
	`repository_id` text NOT NULL,
	`stargazer_id` text NOT NULL,
	PRIMARY KEY(`repository_id`, `stargazer_id`),
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stargazer_id`) REFERENCES `stargazers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `repository_stargazers_stargazer_id_idx` ON `repository_stargazers` (`stargazer_id`);
