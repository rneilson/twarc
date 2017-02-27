--------
-- Up
--------

CREATE TABLE log_type (
  code INTEGER PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  description TEXT,
  to_db BOOLEAN,
  to_file BOOLEAN,
  to_console BOOLEAN
);
INSERT INTO log_type (code, label, description, to_db, to_file, to_console) VALUES
  (0, 'error', 'Error', 1, 1, 1),
  (1, 'warning', 'Warning', 0, 1, 1),
  (2, 'event', 'Event', 1, 1, 1),
  (3, 'info', 'Information', 0, 1, 1),
  (4, 'display', 'Display', 0, 0, 1),
  (5, 'debug', 'Debug', 0, 0, 0);


CREATE TABLE log_data (
  time_ms INTEGER NOT NULL,
  type_code INTEGER NOT NULL
    REFERENCES log_type(code)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  user_id INTEGER
    REFERENCES user_db(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  proc_name TEXT,
  message TEXT NOT NULL
);
CREATE INDEX idx_log_data_by_time ON log_data(time_ms DESC);
CREATE INDEX idx_log_data_by_type_by_time ON log_data(type_code, time_ms DESC);
CREATE INDEX idx_log_data_by_user_by_time ON log_data(user_id, time_ms DESC);

--------
-- Down
--------

DROP INDEX idx_log_data_by_user_by_time;
DROP INDEX idx_log_data_by_type_by_time;
DROP INDEX idx_log_data_by_time;
DROP TABLE log_data;
DROP TABLE log_type;
