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
  (1, 'warning', 'Warning', 1, 1, 1),
  (2, 'info', 'Information', 1, 1, 1),
  (3, 'output', 'Process output', 0, 0, 1),
  (4, 'debug', 'Debug output', 0, 0, 0);


CREATE TABLE log_data (
  timestamp_ms INTEGER NOT NULL,
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
CREATE INDEX idx_log_data_by_time ON log_data(timestamp_ms DESC);
CREATE INDEX idx_log_data_by_type_by_time ON log_data(type_code, timestamp_ms DESC);
CREATE INDEX idx_log_data_by_user_by_time ON log_data(user_id, timestamp_ms DESC);

--------
-- Down
--------

DROP INDEX idx_log_data_by_user_by_time;
DROP INDEX idx_log_data_by_type_by_time;
DROP INDEX idx_log_data_by_time;
DROP TABLE log_data;
DROP TABLE log_type;
