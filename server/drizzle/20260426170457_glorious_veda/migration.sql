ALTER TABLE `repository_stargazers` RENAME TO `stargazers_to_repos`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_stargazers_to_repos` (
	`stargazer_id` integer NOT NULL,
	`repository_id` integer NOT NULL,
	CONSTRAINT `stargazers_to_repos_pk` PRIMARY KEY(`stargazer_id`, `repository_id`),
	CONSTRAINT `fk_stargazers_to_repos_stargazer_id_stargazers_id_fk` FOREIGN KEY (`stargazer_id`) REFERENCES `stargazers`(`id`),
	CONSTRAINT `fk_stargazers_to_repos_repository_id_repositories_id_fk` FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_stargazers_to_repos`(`repository_id`, `stargazer_id`) SELECT `repository_id`, `stargazer_id` FROM `stargazers_to_repos`;--> statement-breakpoint
DROP TABLE `stargazers_to_repos`;--> statement-breakpoint
ALTER TABLE `__new_stargazers_to_repos` RENAME TO `stargazers_to_repos`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `repository_stargazers_stargazer_id_idx`;