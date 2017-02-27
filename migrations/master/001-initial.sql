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
  is_active BOOLEAN,
  last_opened_ms INTEGER
);

--------
-- Down
--------

DROP TABLE user_db;
DROP TABLE config;
