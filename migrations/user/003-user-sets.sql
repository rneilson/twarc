--------
-- Up
--------

CREATE TABLE following (
  user_id INTEGER PRIMARY KEY,
  since_ms INTEGER NOT NULL,
  until_ms INTEGER
);
CREATE INDEX idx_following_by_time
  ON following (since_ms DESC)
  WHERE until_ms IS NULL;


CREATE TABLE follower (
  user_id INTEGER PRIMARY KEY,
  since_ms INTEGER NOT NULL,
  until_ms INTEGER
);
CREATE INDEX idx_follower_by_time
  ON follower (since_ms DESC)
  WHERE until_ms IS NULL;


CREATE TABLE blocked (
  user_id INTEGER PRIMARY KEY,
  since_ms INTEGER NOT NULL,
  until_ms INTEGER
);
CREATE INDEX idx_blocked_by_time
  ON blocked (since_ms DESC)
  WHERE until_ms IS NULL;


CREATE TABLE muted (
  user_id INTEGER PRIMARY KEY,
  since_ms INTEGER NOT NULL,
  until_ms INTEGER
);
CREATE INDEX idx_muted_by_time
  ON muted (since_ms DESC)
  WHERE until_ms IS NULL;

--------
-- Down
--------

DROP INDEX idx_followed_by_time;
DROP TABLE followed;
DROP INDEX idx_follower_by_time;
DROP TABLE follower;
DROP INDEX idx_blocked_by_time;
DROP TABLE blocked;
DROP INDEX idx_muted_by_time;
DROP TABLE muted;
