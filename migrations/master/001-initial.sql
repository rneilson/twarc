--------
-- Up
--------

CREATE TABLE config (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT,
  time_ms INTEGER
);


CREATE TABLE user_db (
  id INTEGER PRIMARY KEY,
  name TEXT,
  screen_name TEXT,
  db_path TEXT,
  token_key TEXT,
  token_secret TEXT,
  is_active BOOLEAN
    NOT NULL
    DEFAULT 0
    CHECK(
      NOT is_active OR
      (token_key IS NOT NULL AND
       token_secret IS NOT NULL)
    ),
  last_opened_ms INTEGER
);

--------
-- Down
--------

DROP TABLE user_db;
DROP TABLE config;
