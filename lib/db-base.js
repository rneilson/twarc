'use strict';

const path = require('path');
const EventEmitter = require('events');
const Sqlite = require('sqlite-pool');
const iterwait = require('./iterwait');
const { decompose, recombine } = require('./parsecfg');
// const Filters = require('./filters');

const sqlite_opts = {
  acquireTimeout: 5000,
  busyTimeout: 5000,
  min: 2,
  max: 4,
};

class BaseDB extends EventEmitter {
  constructor (filename, { create = false }) {
    const db_opts = Object.assign({}, sqlite_opts);

    // Change default open mode if not creating
    db_opts.mode = create
      ? (Sqlite.OPEN_READWRITE | Sqlite.OPEN_CREATE)
      : Sqlite.OPEN_READWRITE;

    // Open database
    this.path = path.resolve(filename);
    this.db = new Sqlite(this.path, db_opts);

    // Set up one-time events for file open
    // Only triggers one or the other of success/error events
    let cb_open, cb_err;
    cb_open = () => {
      // Remove error listener
      this.db.removeListener('error', cb_err);
      cb_err = null;
      // Emit open events
      this.emit('open:success', this.path, this);
      this.emit('open', this.path, this);
    };
    cb_err = (err) => {
      // Remove open listener
      this.db.removeListener('open', cb_open);
      cb_open = null;
      // Emit error events
      this.emit('open:error', err, this);
      if (this.listenerCount('error') > 0) {
        // Only emit 'error' with active listeners, so
        // the process doesn't crash before cleanup
        this.emit('error', err, this);
      }
    };
    this.db.once('open', cb_open);
    this.db.once('error', cb_err);
  }

  async (gen, use = null, start_trx = false) {
    // Just using async() to simplify iterwait()
    if (use === false) {
      return iterwait(get.call(this, this.db));
    }
    // Already have a connection or transaction
    else if (use !== null && use !== undefined) {
      return iterwait(gen.call(this, use));
    }
    // Start a transaction
    else if (start_trx) {
      return this.db.transaction(trx => iterwait(gen.call(this, trx)));
    }
    // Acquire a connection
    else {
      return this.db.use(conn => iterwait(gen.call(this, conn)));
    }
  }

  close () {
    return this.db.close().then(() => this.emit('close', this));
  }

  getconfig (key = '', times = false, trx = null) {
    // Don't want to start a transaction, but do use single connection
    return trx ? _getcfg(trx) : this.db.use(conn => _getcfg(conn));

    function _getcfg (conn) {
      let columns = times ? 'value, time_ms AS time' : 'value';
      let queries;

      if (key) {
        queries = [
          conn.get(`SELECT ${columns} FROM config WHERE key = ?`, [key]),
          conn.all(`SELECT key, ${columns} FROM config WHERE key LIKE ?.%`, [key]),
        ];
      }
      else {
        queries = [
          Promise.resolve(),
          conn.all(`SELECT key, ${columns} FROM config`),
        ];
      }

      return Promise.all(queries).then(([exact, prefixed]) => {
        // Check to make sure we don't have both exact
        // and prefixed under the same key
        if (exact && prefixed.length) {
          throw new Error(`Found both exact and prefixed values for key ${key}`);
        }

        if (exact) {
          return times
            ? [JSON.parse(exact.value), exact.time]
            : JSON.parse(exact.value);
        }

        let valfn = times
          ? row => [row.key, [JSON.parse(row.value), row.time]]
          : row => [row.key, JSON.parse(row.value)];

        return recombine(prefixed.map(valfn), key);
      });
    }
  }

  setconfig (value, key = '', times = false, trx = null) {
    // Start a transaction if one not provided
    return trx ? _setcfg(trx) : this.db.transaction(_trx => _setcfg(_trx));

    function _setcfg (conn) {
      // Decompose value into [k, v] or [k, [v, t]] arrays
      // Array w/o prefix is assumed to already be decomposed
      const toset = (!key && Array.isArray(value)) ? value : decompose(value, key);

      let valfn;
      // Use per-value timestamps
      if (times === true) {
        valfn = ([k, [v, t]]) => [k, JSON.stringify(v), t];
      }
      // Use given timestamp or now
      else {
        let set_time = times || Date.now();
        valfn = ([k, v]) => [k, JSON.stringify(v), set_time];
      }

      // Prepare statements ahead of time to speed things up
      return Promise.all([
        conn.prepare(
          `UPDATE config SET value = ?2, time_ms = ?3
WHERE key = ?1 AND (time_ms IS NULL OR time_ms < ?3)`
        ),
        conn.prepare(
          `DELETE FROM config WHERE key = ?1 AND (time_ms IS NULL OR time_ms < ?2)`
        ),
        conn.prepare(
          `SELECT EXISTS(SELECT 1 FROM config WHERE key LIKE (? || '.%')) AS prefix`
        ),
        conn.prepare(
          `INSERT OR IGNORE INTO config(key, value, time_ms) VALUES (?, ?, ?)`
        ),
      ])
      .then(([upd, del, chk, ins]) =>
        Promise.all(toset.map(val => {
          // Get [k, v, t] array
          const kvt = valfn(val);
          const [k, v, t] = kvt;

          // Delete instead of update if value is undefined
          const upd_or_del = v === undefined
            ? del.run([k, t])
            : upd.run(kvt);

          // Now the tricky bit: have to try updating each key if
          // new timestamp is higher; then, if it doesn't update,
          // only insert if key isn't already a prefix of others.
          return upd_or_del.then(({ changes }) => {
            if (changes) {
              return true;
            }
            return chk.get(k).then(({ prefix }) => {
              if (prefix) {
                throw new Error(`Key ${k} is already a prefix of other keys`);
              }
              return v === undefined
                ? false
                : ins.run(kvt).then(({ changes }) => !!changes);
            });
          });
        }))
      );
    }
  }

}

module.exports = BaseDB;
