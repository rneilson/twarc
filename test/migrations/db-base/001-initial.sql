--------
-- Up
--------

CREATE TABLE config (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT,
  time_ms INTEGER
);
INSERT INTO config (key, value, time_ms) VALUES
  ('app.test1', 'true', 1488210932000),
  ('app.test2', 'false', 1488210932000),
  ('app.test3', 'null', 1488210932000),
  ('app.obj.test1', '"beep"', 1488210932000),
  ('app.obj.test2', '"boop"', 1488210932000),
  ('app.obj.test3', '["beep", "boop"]', 1488210932000),
  ('dir.test', '"./test/"', 1488210932000),
  ('dir.sql', '"./test/migrations/db-base/"', 1488210932000);


--------
-- Down
--------

DROP TABLE config;
