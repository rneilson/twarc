--------
-- Up
--------

-- Notes:
--  - alias and mention are one-off insert-only
--  - alias will store old screen names in case of older tweet text
--    - timestamp indicates when user_id/screen_name combo first seen
--    - new alias entry will be made when user inserted or screen_name updated
--    - alias entries must be manually inserted for mentions
--  - mention is basically a big index for tweets' user_mentions plus RTs/quotes
--    - mention timestamps will be updated when tweet timestamps are
--    - mentions will be deleted when tweets are (normally handled by foreign keys)
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
CREATE TRIGGER tri_add_alias_on_user_insert
  AFTER INSERT ON user
  WHEN new.screen_name IS NOT NULL
  BEGIN
    INSERT OR REPLACE INTO alias (user_id, screen_name, timestamp_ms)
    VALUES (new.id, new.screen_name, new.timestamp_ms);
  END;
CREATE TRIGGER tri_add_alias_on_user_screen_name_update
  AFTER UPDATE OF screen_name ON user
  WHEN new.screen_name IS NOT NULL
   AND new.screen_name != old.screen_name
  BEGIN
    INSERT OR REPLACE INTO alias (user_id, screen_name, timestamp_ms)
    VALUES (new.id, new.screen_name, new.timestamp_ms);
  END;


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
CREATE TRIGGER tri_update_mention_on_tweet_timestamp_update
  AFTER UPDATE OF timestamp_ms ON tweet
  WHEN new.timestamp_ms != old.timestamp_ms
  BEGIN
    UPDATE mention SET timestamp_ms = new.timestamp_ms
    WHERE tweet_id = new.id;
  END;
CREATE TRIGGER tri_delete_mention_on_tweet_delete
  BEFORE DELETE ON tweet
  BEGIN
    DELETE FROM mention
    WHERE tweet_id = old.id;
  END;


CREATE TABLE deleted (
  id INTEGER PRIMARY KEY,
  json JSON,
  timestamp_ms INTEGER NOT NULL
);

--------
-- Down
--------

DROP TABLE deleted;
DROP TRIGGER tri_delete_mention_on_tweet_delete;
DROP TRIGGER tri_update_mention_on_tweet_timestamp_update;
DROP INDEX idx_mention_quote_by_time;
DROP INDEX idx_mention_retweet_by_time;
DROP INDEX idx_mention_reply_by_time;
DROP INDEX idx_mention_of_user_by_time;
DROP INDEX idx_mention_by_user_by_time;
DROP TABLE mention;
DROP TRIGGER tri_add_alias_on_user_screen_name_update;
DROP TRIGGER tri_add_alias_on_user_insert;
DROP INDEX idx_alias_by_user_by_time;
DROP INDEX idx_alias_by_screen_name;
DROP TABLE alias;
