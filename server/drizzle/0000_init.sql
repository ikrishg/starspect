CREATE TABLE IF NOT EXISTS `tokens` (
  `user_id` text PRIMARY KEY NOT NULL,
  `username` text NOT NULL,
  `github_token` text NOT NULL,
  `refresh_token` text,
  `last_token_use_at` integer NOT NULL
);
