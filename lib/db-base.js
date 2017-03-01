'use strict';

const _ = require('lodash');
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
  constructor (filename, { create_file = false, single_conn = false } = {}) {
    super();

    const db_opts = Object.assign({}, sqlite_opts);

    // Change default open mode if not creating
    db_opts.mode = create_file
      ? (Sqlite.OPEN_READWRITE | Sqlite.OPEN_CREATE)
      : Sqlite.OPEN_READWRITE;

    // Clamp pool min/max in single mode
    if (single_conn) {
      db_opts.min = 1;
      db_opts.max = 1;
    }

    // Open database
    // Don't allow anonymous file-based, too finicky
    this.path = (!filename || filename === ':memory:')
      ? ':memory:'
      : path.resolve(filename);
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

    // Config cache
    this.config = {};
  }

  close () {
    return this.db.close().then(() => {
      this.emit('close', this);
      return this;
    });
  }

  run_async (gen, {use_conn = null, start_trx = false, delay} = {}) {
    // Just using run_async() to simplify iterwait()
    if (use_conn === false) {
      return iterwait(get.call(this, this.db), delay);
    }
    // Already have a connection or transaction
    else if (use_conn) {
      return iterwait(gen.call(this, use_conn), delay);
    }
    // Start a transaction
    else if (start_trx) {
      return this.db.transaction(trx => iterwait(gen.call(this, trx), delay));
    }
    // Acquire a connection
    else {
      return this.db.use(conn => iterwait(gen.call(this, conn), delay));
    }
  }

  /**
   *  Fetches config key(s)/value(s), returns as single entry/object
   */
  get_config (key, times = false, trx = null) {
    // Don't want to start a transaction, but do use single connection
    return trx
      ? _getcfg.call(this, trx)
      : this.db.use(conn => _getcfg.call(this, conn));

    function _getcfg (conn) {
      const columns = times ? 'value, time_ms AS time' : 'value';
      let queries;

      if (key) {
        queries = [
          conn.get(
            `SELECT ${columns} FROM config WHERE key = ?`,
            [key]
          ),
          conn.all(
            `SELECT key, ${columns} FROM config WHERE key LIKE (? || '.%')`,
            [key]
          ),
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

        const extract = (entry) => {
          const key = entry.key;
          const value = JSON.parse(entry.value);

          // Update config cache
          _.set(this.config, key, value);

          return times
            ? [key, [value, entry.time]]
            : [key, value];
        };

        if (exact) {
          // Will only be exact if key supplied
          exact.key = key;
          // Update cache, return value only
          return extract(exact)[1];
        }

        // Otherwise (either key not found or key is prefix) we
        // have to recombine the entries into a composite value
        return prefixed.length
          ? recombine(prefixed.map(extract), key)
          : undefined;
      });
    }
  }

  set_config (value, key = '', times = false, trx = null) {
    // Start a transaction if one not provided
    return trx
      ? _setcfg.call(this, trx)
      : this.db.transaction(_trx => _setcfg.call(this, _trx));

    function _setcfg (conn) {
      // Decompose value into [k, v] or [k, [v, t]] arrays
      // Array w/o prefix is assumed to already be decomposed
      const entries = (!key && Array.isArray(value)) ? value : decompose(value, key);

      let valfn;
      // Use per-value timestamps
      if (times === true) {
        valfn = ([k, [v, t]]) => [k, JSON.stringify(v), t];
      }
      // Use given timestamp or now
      else {
        let set_time = times ? new Date(times).getTime() : Date.now();
        valfn = ([k, v]) => [k, JSON.stringify(v), set_time];
      }

      // Prepare statements ahead of time to speed things up
      return Promise.all([
        conn.prepare(
          `UPDATE config SET value = ?2, time_ms = ?3
WHERE key = ?1 AND (time_ms IS NULL OR time_ms < ?3)`
        ),
        conn.prepare(
          `SELECT EXISTS(SELECT 1 FROM config WHERE key LIKE (? || '.%')) AS prefix`
        ),
        conn.prepare(
          `INSERT OR IGNORE INTO config(key, value, time_ms) VALUES (?, ?, ?)`
        ),
      ])
      .then((statements) => {
        let [ upd, chk, ins ] = statements;

        return Promise.all(entries.map((val) => {
          // Get [k, v, t] array
          const kvt = valfn(val);
          const [k, v, t] = kvt;

          // Do not update if value is undefined
          if (v === undefined) {
            return [k, false];
          }

          // Now the tricky bit: have to try updating each key if
          // new timestamp is higher; then, if it doesn't update,
          // only insert if key isn't already a prefix of others.
          return upd.run(kvt).then(({ changes }) => {
            if (changes) {
              return [k, true];
            }
            return chk.get(k).then(({ prefix }) => {
              if (prefix) {
                throw new Error(`Key ${k} is already a prefix of other keys`);
              }
              return ins.run(kvt).then(({ changes }) => [k, !!changes]);
            });
          })
          .then((changed) => {
            // Update cache if key updated/inserted
            if (changed[1]) {
              _.set(this.config, k, times ? val[1][0] : val[1]);
            }
            return changed;
          });
        }))
        .then(result =>
          Promise.all(statements.map(x => x.finalize()))
          .then(() => result)
        )
        .catch(err =>
          Promise.all(statements.map(x => x.finalize()))
          .then(() => Promise.reject(err))
        );
      });
    }
  }

  del_config (key, times = false, trx = null) {
    if (!key) {
      return Promise.reject(new Error(`Must specify key to be deleted`));
    }

    return trx ? _delcfg(trx) : this.db.transaction(_trx => _delcfg(_trx));

    function _delcfg (conn) {
      return Promise.all([
        conn.get(
          `SELECT key, time_ms AS time FROM config WHERE key = ?`,
          [key]
        ),
        conn.all(
          `SELECT key, time_ms AS time FROM config WHERE key LIKE (? || '.%')`,
          [key]
        ),
      ])
      .then(([ exact, prefixed ]) => {
        // Check to make sure we don't have both exact
        // and prefixed under the same key
        if (exact && prefixed.length) {
          throw new Error(`Found both exact and prefixed values for key ${key}`);
        }

        let postfn = ({ changes }) => !!changes;
        let del_time = times
          ? times === true
            ? Date.now()
            : new Date(times).getTime()
          : false;

        if (exact) {
          return (!del_time || exact.time <= del_time)
            ? conn.run(`DELETE FROM config WHERE key = ?`, [key]).then(postfn)
            : false;
        }

        // Ensure all timestamps are at or below given time
        if (del_time) {
          let eligible = 0;
          for (let p of prefixed) {
            if (p.time <= del_time) {
              eligible++;
            }
          }

          // Delete all or none
          if (eligible !== prefixed.length) {
            return false;
          }
        }

        return conn.run(
          `DELETE FROM config WHERE key LIKE (? || '.%')`,
          [key]
        )
        .then(postfn);

      });
    }
  }

}

module.exports = BaseDB;
