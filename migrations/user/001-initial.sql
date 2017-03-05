--------
-- Up
--------

-- Notes:
--  - Have to remember to cast to text when extracting bigint ids, due to JS numbers
--  - No foreign key constraints to explicitly allow for dangling refs
--    - Not all tweets will be fetched/saved
--    - Not all users will have full details when encountered
--  - Can convert timestamps to ISO datetime strings using:
--      strftime('%Y-%m-%dT%H:%M:%fZ', CAST(time_ms AS REAL)/1000, 'unixepoch')
--  - Can convert datetime strings to timestamps (w/o ms) using:
--      strftime('%s', dt)*1000 - strftime('%S', dt)*1000 + strftime('%f', dt)*1000

CREATE TABLE config (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT,
  time_ms INTEGER
);
-- Check before insert, must equal 0:
--  SELECT count(key) AS keys FROM config WHERE key LIKE (? || '.%')
--  SELECT EXISTS(SELECT 1 FROM config WHERE key LIKE (? || '.%')) AS keys


CREATE TABLE tweet (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  in_reply_to_id INTEGER,
  in_reply_to_user_id INTEGER,
  retweeted_id INTEGER,
  quoted_id INTEGER,
  full_text TEXT,
  json JSON,
  time_ms INTEGER NOT NULL
);
CREATE INDEX idx_tweet_by_time ON tweet (time_ms DESC);
CREATE INDEX idx_tweet_by_user_by_time ON tweet (user_id, time_ms DESC);
CREATE INDEX idx_tweet_in_reply_to_by_time
  ON tweet (in_reply_to_id, time_ms)
  WHERE in_reply_to_id IS NOT NULL;
CREATE INDEX idx_tweet_in_reply_to_user_by_user_by_time
  ON tweet (in_reply_to_user_id, user_id, time_ms DESC)
  WHERE in_reply_to_user_id IS NOT NULL;
CREATE INDEX idx_tweet_retweeted_by_time
  ON tweet (retweeted_id, time_ms)
  WHERE retweeted_id IS NOT NULL;
CREATE INDEX idx_tweet_quoted_by_time
  ON tweet (quoted_id, time_ms)
  WHERE quoted_id IS NOT NULL;


CREATE TABLE user (
  id INTEGER PRIMARY KEY,
  screen_name TEXT,
  name TEXT,
  json JSON,
  time_ms INTEGER NOT NULL
);
CREATE INDEX idx_user_by_screen_name ON user (screen_name);
CREATE INDEX idx_user_by_name ON user (name);


CREATE TABLE favorite (
  tweet_id INTEGER PRIMARY KEY,
  time_ms INTEGER NOT NULL
);
CREATE INDEX idx_favorite_by_time ON favorite (time_ms DESC);

--------
-- Down
--------

DROP INDEX idx_favorite_by_time;
DROP TABLE favorite;
DROP INDEX idx_user_by_screen_name;
DROP INDEX idx_user_by_name;
DROP TABLE user;
DROP INDEX idx_tweet_quoted_by_time;
DROP INDEX idx_tweet_retweeted_by_time;
DROP INDEX idx_tweet_in_reply_to_user_by_user_by_time;
DROP INDEX idx_tweet_in_reply_to_by_time;
DROP INDEX idx_tweet_by_user_by_time;
DROP INDEX idx_tweet_by_time;
DROP TABLE tweet;
DROP TABLE status;
