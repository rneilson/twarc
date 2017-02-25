--------
-- Up
--------

-- Notes:
--  - alias and mention are one-off insert-only
--  - alias will store old screen names in case of older tweet text
--  - mention is basically a big index for tweets' user_mentions
--  - deleted will store original tweet object if available, despite
--    technically being required to actually delete stored tweets

CREATE TABLE alias (
  user_id INTEGER NOT NULL,
  screen_name TEXT NOT NULL,
  timestamp_ms INTEGER,
  PRIMARY KEY(user_id, screen_name)
);
CREATE INDEX idx_alias_by_screen_name ON alias (screen_name);
CREATE INDEX idx_alias_by_user_by_time ON alias (user_id, timestamp_ms DESC);


CREATE TABLE mention (
  tweet_id INTEGER NOT NULL,
  of_user_id INTEGER NOT NULL,
  by_user_id INTEGER NOT NULL,
  reply_to_user_id INTEGER,
  quoted_user_id INTEGER,
  retweeted_user_id INTEGER,
  timestamp_ms INTEGER NOT NULL,
  PRIMARY KEY(tweet_id, of_user_id)
);
CREATE INDEX idx_mention_by_user_by_time ON mention (by_user_id, timestamp_ms DESC);
CREATE INDEX idx_mention_of_user_by_time ON mention (of_user_id, timestamp_ms DESC);
CREATE INDEX idx_mention_reply_by_time
  ON mention (reply_to_user_id, timestamp_ms DESC)
  WHERE reply_to_user_id IS NOT NULL;
CREATE INDEX idx_mention_retweet_by_time
  ON mention (retweeted_user_id, timestamp_ms DESC)
  WHERE retweeted_user_id IS NOT NULL;
CREATE INDEX idx_mention_quote_by_time
  ON mention (quoted_user_id, timestamp_ms DESC)
  WHERE quoted_user_id IS NOT NULL;


CREATE TABLE deleted (
  id INTEGER PRIMARY KEY,
  json JSON,
  timestamp_ms INTEGER NOT NULL
);

--------
-- Down
--------

DROP INDEX idx_alias_by_screen_name;
DROP TABLE alias;
DROP INDEX idx_mention_by_user_by_time;
DROP INDEX idx_mention_of_user_by_time;
DROP INDEX idx_mention_reply_by_time;
DROP INDEX idx_mention_retweet_by_time;
DROP INDEX idx_mention_quote_by_time;
DROP TABLE mention;
DROP TABLE deleted;
