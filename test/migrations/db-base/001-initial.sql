--------
-- Up
--------

CREATE TABLE config (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT,
  time_ms INTEGER
);
INSERT INTO config (key, value) VALUES
  ('app.test1', 'true'),
  ('app.test2', 'false'),
  ('app.test3', 'null'),
  ('app.obj.test1', '"beep"'),
  ('app.obj.test2', '"boop"'),
  ('app.obj.test3', '["beep", "boop"]'),
  ('dir.test', '"./test/"'),
  ('dir.sql', '"./test/migrations/db-base/"');


--------
-- Down
--------

DROP TABLE config;
