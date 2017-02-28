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
  access_token_key TEXT,
  access_token_secret TEXT,
  is_active BOOLEAN
    NOT NULL
    DEFAULT 0
    CHECK(
      NOT is_active OR
      (access_token_key IS NOT NULL AND
       access_token_secret IS NOT NULL)
    ),
  last_opened_ms INTEGER,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);

--------
-- Down
--------

DROP TABLE user_db;
DROP TABLE config;
