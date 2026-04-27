ALTER TABLE `repositories` ADD `name` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_stargazers_to_repos` (
	`stargazer_username` text NOT NULL,
	`repository_id` text NOT NULL,
	CONSTRAINT `stargazers_to_repos_pk` PRIMARY KEY(`stargazer_username`, `repository_id`),
	CONSTRAINT `fk_stargazers_to_repos_stargazer_username_stargazers_username_fk` FOREIGN KEY (`stargazer_username`) REFERENCES `stargazers`(`username`),
	CONSTRAINT `fk_stargazers_to_repos_repository_id_repositories_name_fk` FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`name`)
);
--> statement-breakpoint
INSERT INTO `__new_stargazers_to_repos`(`stargazer_username`, `repository_id`) SELECT `stargazer_username`, `repository_id` FROM `stargazers_to_repos`;--> statement-breakpoint
DROP TABLE `stargazers_to_repos`;--> statement-breakpoint
ALTER TABLE `__new_stargazers_to_repos` RENAME TO `stargazers_to_repos`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_repositories` (
	`name` text PRIMARY KEY,
	`n_stars` integer,
	`n_fake_stars` integer,
	`n_low_activity` integer,
	`n_activity_cluster` integer,
	`score` integer,
	`checked_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_repositories`(`n_stars`, `n_fake_stars`, `n_low_activity`, `n_activity_cluster`, `score`, `checked_at`) SELECT `n_stars`, `n_fake_stars`, `n_low_activity`, `n_activity_cluster`, `score`, `checked_at` FROM `repositories`;--> statement-breakpoint
DROP TABLE `repositories`;--> statement-breakpoint
ALTER TABLE `__new_repositories` RENAME TO `repositories`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `repository_owner_repo_idx`;