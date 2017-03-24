--------
-- Up
--------

ALTER TABLE follower
  RENAME TO followers;

--------
-- Down
--------

ALTER TABLE followers
  RENAME TO follower;

