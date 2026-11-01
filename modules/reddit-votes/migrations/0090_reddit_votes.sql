-- Upvotes and comment counts of collected Reddit posts, read from the Arctic Shift archive (modules/reddit-votes).
CREATE TABLE IF NOT EXISTS reddit_votes (article_id text PRIMARY KEY, post_id text NOT NULL, score integer NOT NULL, comments integer NOT NULL, checked_at timestamptz NOT NULL DEFAULT now());
