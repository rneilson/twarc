--------
-- Up
--------

INSERT INTO config (key, value) VALUES
  ('app.consumer_key', '"W5CcvQdttYmoB0QG4woYKe14a"'),
  ('app.consumer_secret', '"gXtU0MpI7SFzCUBAfh3HPzJmvMBBa5zqXSdk5OMTg11JHZLvRs"'),
  ('app.name', '"rn-twarc"'),
  ('dir.db', '"./data/db/"'),
  ('dir.log', '"./data/log/"'),
  ('dir.sock', '"./data/sock/"'),
  ('log.default_type', '"info"'),
  ('log.error.default_type', '"error"'),
  ('log.error.use_stack', 'true'),
  ('log.file.keep', 'true'),
  ('log.file.merge', 'true'),
  ('log.file.rotate', 'true');

--------
-- Down
--------

DELETE FROM config;
