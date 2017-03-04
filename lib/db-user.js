'use strict';

const _ = require('lodash');
const path = require('path');
const iterwait = require('./iterwait');
const BaseDB = require('./db-base');
const Filters = require('./filters');
const StatementCache = require('./cache-stmt');
// const { decompose, recombine } = require('./parsecfg');

class UserDB extends BaseDB {

  constructor (filename, options = {}) {
    if (!filename) {
      throw new Error('No filename given');
    }

    super(filename, _.pick(options, ['create_file', 'single_conn']));

    if (!options.user_id && _.get(options, 'require_id', true)) {
      throw new Error('No user id given');
    }
    this.id_str = options.user_id ? String(options.user_id) : null;

    // this.options = options;
  }

  static open (filename, options = {}) {
    return iterwait((function* () {
      let user;
      try {
        user = yield new Promise((resolve, reject) => {
          // Event handlers - each will remove the other when called
          let on_open, on_err;
          on_open = (file, base_db) => {
            base_db.removeListener('open:error', on_err);
            resolve(base_db);
          };
          on_err = (err, base_db) => {
            const fn = () => reject(err);
            base_db.removeListener('open:success', on_open);
            base_db.close().then(fn, fn);
          };

          // Create and register event handlers
          new UserDB(filename, options)
            .once('open:success', on_open)
            .once('open:error', on_err);
        });

        if (_.get(options, 'migrate', true)) {
          yield user.db.migrate({
            force: _.get(options, 'force', false),
            migrationsPath: path.join(__dirname, '../migrations/user'),
          });
        }

        if (_.get(options, 'init', true)) {
          yield user._init();
        }
      }
      finally {
        if (user) {
          yield user.close();
        }
      }

      return user;
    })());
  }

  _init () {
    return this.run_async(function* (trx) {
      // get_config() will update cache itself
      yield this.get_config('', { trx });

      // Check to ensure stored and given user id match
      if (this.id_str) {
        const user = this.config.user;

        if (!user || !user.id_str) {
          yield this.set_config(this.id_str, 'user.id_str', { trx });
        }
        else if (this.id_str !== user.id_str)
          throw new Error(
            `Given user id ${this.id_str} doesn't match stored id ${user.id_str}`
          );
        }
      }

      // TODO: load usersets?

      return this;
    }, { start_trx: true });
  }

  write_item () {}

  write_queue () {}

  get_user_by_id (id_str, { cache = null, trx = null }) {
    return this.run_async(function* _get_user (conn) {
      // Prepare statement
      const use_cache = cache || new StatementCache(conn);
      const get_short_by_id = yield use_cache.load(
        `SELECT json, time_ms FROM user WHERE id = ?`
        'user.get_short_by_id'
      );

      // Fetch user data
      const user_data = yield get_short_by_id.get([id_str]);

      // Finalize statements if not using provided cache
      if (!cache) {
        yield use_cache.finalize();
      }

      // Parse as req'd and return
      return user_data
        ? {
          user: JSON.parse(user_data.json),
          time_ms: user_data.time_ms
        }
        : null;
    }, { use_conn: conn });
  }

  write_user (user_obj, { cache = null, trx = null }) {
    return this.run_async(function* _write_user (conn) {
      // Prepare statement
      const use_cache = cache || new StatementCache(conn);
      const { get_full_by_id, update_by_id, insert } = yield use_cache.load({
        get_full_by_id: `SELECT screen_name, name, json, time_ms
FROM user WHERE id = ?`,

        update_by_id: `UPDATE user
SET screen_name = ?2, name = ?3, json = ?4, time_ms = ?5
WHERE id = ?1`,

        insert: `INSERT INTO user (id, screen_name, name, json, time_ms)
VALUES (?, ?, ?, ?, ?)`,
      }, 'user');

      // Get stored user, if any
      const curr_obj = yield get_full_by_id.get([user_obj.user.id_str]);

      // Insert new, or compare and possibly update
      const upd_id_str = user_obj.user.id_str;
      const upd_time = ensure_time(user_obj.time_ms);
      let changed = false;

      // Insert new
      if (!curr_obj) {
        const { changes } = yield insert.run([
          upd_id_str,
          user_obj.user.screen_name,
          user_obj.user.name,
          JSON.stringify(user_obj.user),
          upd_time
        ]);
        changed = !!changes;
      }
      // Compare and possibly update
      else if (curr_obj.time_ms < upd_time &&
               (curr_obj.screen_name !== user_obj.user.screen_name ||
                curr_obj.name !== user_obj.user.name ||
                !Filters.equaluser(JSON.parse(curr_obj.json), user_obj.user))) {
        const { changes } = yield update_by_id.run([
          upd_id_str,
          user_obj.user.screen_name,
          user_obj.user.name,
          JSON.stringify(user_obj.user),
          upd_time
        ]);
        changed = !!changes;
      }

      // Finalize statements if not using provided cache
      if (!cache) {
        yield use_cache.finalize();
      }

      // Check for db user update
      if (changed &&
          upd_id_str === this.config.user.id_str &&
          (user_obj.user.screen_name !== this.config.user.screen_name ||
           user_obj.user.name !== this.config.user.name)) {
        const cfg_res = yield this.set_config(
          {
            screen_name: user_obj.user.screen_name,
            name: user_obj.user.name
          },
          'user',
          { time: upd_time, trx: conn }
        );

        // Return object with sub-results instead
        return { config: cfg_res, user: [upd_id_str, changed] };
      }

      return [upd_id_str, changed];
    }, { use_conn: trx, start_trx: true });
  }

  write_user_set () {}

  update_user_set () {}

  write_tweet () {}

  delete_tweet () {}

  write_aliases (aliases, { cache = null, trx = null }) {
    const a_list = _.isArray(aliases) ? aliases : [aliases];

    return this.run_async(function* _write_alias (conn) {
      // Prepare statement
      const use_cache = cache || new StatementCache(conn);
      const insert = yield use_cache.load(
        `INSERT OR IGNORE
INTO alias (user_id, screen_name, time_ms)
VALUES (?, ?, ?)`,
        'alias.insert'
      );

      // Insert each
      const now = Date.now();
      const results = yield Promise.all(a_list.map(
        (a) => {
          // Check constraints will skip insert if req'd fields missing
          return insert.run([
            a.user_id_str,
            a.screen_name,
            ensure_time(a.time_ms, now)
          ])
          .then(({ changes }) => [[a.user_id_str, a.screen_name], !!changes]);
        }
      ));

      // Finalize statements if not using provided cache
      if (!cache) {
        yield use_cache.finalize();
      }

      return results;
    }, { use_conn: trx, start_trx: true });
  }

  write_mentions (mentions, { cache = null, trx = null }) {
    const m_list = _.isArray(mentions) ? mentions : [mentions];

    return this.run_async(function* _write_mention (conn) {
      // Prepare statement
      const use_cache = cache || new StatementCache(conn);
      const insert = yield use_cache.load(
        `INSERT OR IGNORE
INTO mention (
  tweet_id,
  of_user_id,
  by_user_id,
  reply_to_user_id,
  quoted_user_id,
  retweeted_user_id,
  time_ms
)
VALUES (?, ?, ?, ?, ?, ?, ?)`,
        'mention.insert'
      );

      // Insert each
      const now = Date.now();
      const results = yield Promise.all(m_list.map(
        (m) => {
          // Check constraints will skip insert if req'd fields missing
          return insert.run([
            m.tweet_id_str,
            m.of_user_id_str,
            m.by_user_id_str,
            m.reply_to_user_id_str || null,
            m.quoted_user_id_str || null,
            m.retweeted_user_id_str || null,
            ensure_time(m.time_ms, now)
          ])
          .then(({ changes }) => [[m.tweet_id_str, m.of_user_id_str], !!changes]);
        }
      ));

      // Finalize statements if not using provided cache
      if (!cache) {
        yield use_cache.finalize();
      }

      return results;
    }, { use_conn: trx, start_trx: true });
  }

  _update_fav (favorite, sql, name, cache) {
    return function* (conn) {
      // Prepare statement
      const use_cache = cache || new StatementCache(conn);
      const statement = yield use_cache.load(sql, name);

      // Insert/delete
      const { changes } = yield statement.run([
        favorite.tweet_id_str,
        ensure_time(favorite.time_ms)
      ]);

      // Finalize statement if not using provided cache
      if (!cache) {
        yield use_cache.finalize();
      }

      return [favorite.tweet_id_str, !!changes];
    }
  }

  write_fav (favorite, { cache = null, trx = null }) {
    return this.run_async(
      this._update_fav(
        favorite,
        `INSERT OR IGNORE INTO favorite (tweet_id, time_ms) VALUES (?, ?)`,
        'favorite.insert',
        cache
      ),
      { use_conn: trx, start_trx: true }
    );
  }

  delete_fav (favorite, { cache = null, trx = null }) {
    return this.run_async(
      this._update_fav(
        favorite,
        `DELETE FROM favorite WHERE tweet_id = ? AND time_ms <= ?`,
        'favorite.delete',
        cache
      ),
      { use_conn: trx, start_trx: true }
    );
  }

}

function ensure_time (time, now) {
  return (time === undefined || time === null)
    ? Number.isInteger(now)
      ? now
      : Date.now()
    : Number.isInteger(time)
      ? time
      : new Date(time).getTime();
}

module.exports = UserDB;
