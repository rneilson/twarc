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

  get_user_by_id (id_str, { trx = null } = {}) {
    return this.run_async(function* _get_user (conn) {
      // Fetch user data
      const user_data = yield conn.get(
        `SELECT json, time_ms FROM user WHERE id = ?`,
        id_str
      );

      // Parse as req'd and return
      return user_data
        ? {
          user: JSON.parse(user_data.json),
          time_ms: user_data.time_ms
        }
        : null;
    }, { use_conn: conn });
  }

  write_user (user_obj, { trx = null } = {}) {
    return this.run_async(function* _write_user (conn) {
      // Insert new, or compare and possibly update
      const user_id_str = user_obj.user.id_str;
      const user_time = ensure_time(user_obj.time_ms);
      let changed = false;

      // Get stored user, if any
      const curr_obj = yield conn.get(
        `SELECT screen_name, name, json, time_ms
FROM user WHERE id = ?`,
        user_id_str
      );

      // Insert new if not found
      if (!curr_obj) {
        const { changes } = yield conn.run(
          `INSERT INTO user (id, screen_name, name, json, time_ms)
VALUES (?, ?, ?, ?, ?)`,
          [
            user_id_str,
            user_obj.user.screen_name,
            user_obj.user.name,
            JSON.stringify(user_obj.user),
            user_time
          ]
        );
        changed = !!changes;
      }
      // Compare and possibly update if found
      else if (curr_obj.time_ms < user_time &&
               (curr_obj.screen_name !== user_obj.user.screen_name ||
                curr_obj.name !== user_obj.user.name ||
                !Filters.equaluser(JSON.parse(curr_obj.json), user_obj.user))) {
        const { changes } = yield conn.run(
          `UPDATE user
SET screen_name = ?2, name = ?3, json = ?4, time_ms = ?5
WHERE id = ?1`,
          [
            user_id_str,
            user_obj.user.screen_name,
            user_obj.user.name,
            JSON.stringify(user_obj.user),
            user_time
          ]
        );
        changed = !!changes;
      }

      const result = [user_id_str, changed];

      // Check for db user update
      if (changed && this.id_str === user_id_str &&
          (user_obj.user.id_str !== this.config.user.id_str ||
           user_obj.user.screen_name !== this.config.user.screen_name ||
           user_obj.user.name !== this.config.user.name)) {
        const cfg_res = yield this.set_config(
          {
            id_str: user_id_str,
            screen_name: user_obj.user.screen_name,
            name: user_obj.user.name
          },
          'user',
          { time: user_time, trx: conn }
        );

        // Return object with sub-results instead
        return { config: cfg_res, user: [result] };
      }

      return result;
    }, { use_conn: trx, start_trx: true });
  }

  write_tweet (tweet, { trx = null } = {}) {
    return this.run_async(function* _write_tweet (conn) {
      const tweet_time = ensure_time(parseInt(tweet.timestamp_ms));
      const tweet_id_str = tweet.id_str;
      const user_id_str = tweet.user.id_str;
      let changed = false;

      // Check if tweet already present
      const curr_tweet = yield conn.get(
        `SELECT time_ms FROM tweet WHERE id = ?`,
        tweet_id_str
      );

      if (curr_tweet) {
        // Only update timestamp (and json, which includes new timestamp)
        if (curr_tweet.time_ms < tweet_time) {
          const { changes } = yield conn.run(
            `UPDATE tweet SET time_ms = ?, json = ? WHERE id = ?`,
            [tweet_time, JSON.stringify(tweet), tweet_id_str]
          );
          changed = !!changes;
        }
        // Otherwise nothing to do
      }
      else {
        // Not found, insert new
        const { changes } = yield conn.run(
          `INSERT
  INTO tweet (
    id,
    user_id,
    in_reply_to_id,
    in_reply_to_user_id,
    retweeted_id,
    quoted_id,
    full_text,
    json,
    time_ms
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            tweet_id_str,
            user_id_str,
            _.get(tweet, 'in_reply_to_status_id_str', null),
            _.get(tweet, 'in_reply_to_user_id_str', null),
            _.get(tweet, 'retweeted_status.id_str', null),
            _.get(tweet, 'quoted_status.id_str', null),
            tweet.text,
            JSON.stringify(tweet),
            tweet_time
          ]
        );
        changed = !!changes;
      }

      const result = [tweet_id_str, changed];

      // Check for mentions
      const user_mentions = _.get(tweet, 'entities.user_mentions', []);
      if (changed && user_mentions.length) {
        // Insert aliases
        const { alias } = yield this.write_aliases(
          user_mentions.map(m => ({
            user_id_str: m.id_str,
            screen_name: m.screen_name,
            time_ms: tweet_time
          })),
          { trx: conn }
        );

        // Insert mentions
        const reply_to_user = _.get(tweet, 'in_reply_to_user_id_str', null);
        const quoted_user = _.get(tweet, 'retweeted_status.user.id_str', null);
        const retweeted_user = _.get(tweet, 'quoted_status.user.id_str', null);

        const { mention } = yield this.write_mentions(
          user_mentions.map(m => ({
            tweet_id_str,
            of_user_id_str: m.id_str,
            by_user_id_str: user_id_str,
            reply_to_user_id_str: reply_to_user,
            quoted_user_id_str: quoted_user,
            retweeted_user_id_str: retweeted_user,
          })),
          { trx: conn }
        );

        // Return object with sub-results instead
        return { tweet: [result], alias, mention };
      }

      return result;
    }, { use_conn: trx, start_trx: true });
  }

  delete_tweet (del, { trx = null } = {}) {
    return this.run_async(function* _write_tweet (conn) {
      // TODO
    }, { use_conn: trx, start_trx: true });
  }

  write_aliases (aliases, { trx = null } = {}) {
    const a_list = _.isArray(aliases) ? aliases : [aliases];

    return this.run_async(function* _write_alias (conn) {
      // Prepare statement
      const insert = yield conn.prepare(
        `INSERT OR IGNORE
INTO alias (user_id, screen_name, time_ms)
VALUES (?, ?, ?)`
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

      // Finalize statement
      yield insert.finalize();

      return { alias: results };
    }, { use_conn: trx, start_trx: true });
  }

  write_mentions (mentions, { trx = null } = {}) {
    const m_list = _.isArray(mentions) ? mentions : [mentions];

    return this.run_async(function* _write_mention (conn) {
      // Prepare statement
      const insert = yield conn.prepare(
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
VALUES (?, ?, ?, ?, ?, ?, ?)`
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

      // Finalize statement
      yield insert.finalize();

      return { mention: results };
    }, { use_conn: trx, start_trx: true });
  }

  write_fav (favorite, { trx = null } = {}) {
    return this.run_async(
      function* _write_fav (conn) {
        // Insert/delete
        const { changes } = yield conn.run(
          `INSERT OR IGNORE INTO favorite (tweet_id, time_ms) VALUES (?, ?)`,
          [favorite.tweet_id_str, ensure_time(favorite.time_ms)]
        );

        return [favorite.tweet_id_str, !!changes];
      },
      { use_conn: trx, start_trx: true }
    );
  }

  delete_fav (favorite, { trx = null } = {}) {
    return this.run_async(
      function* _delete_fav (conn) {
        // Insert/delete
        const { changes } = yield conn.run(
        `DELETE FROM favorite WHERE tweet_id = ? AND time_ms <= ?`,
          [favorite.tweet_id_str, ensure_time(favorite.time_ms)]
        );

        return [favorite.tweet_id_str, !!changes];
      },
      { use_conn: trx, start_trx: true }
    );
  }

  write_user_set () {}

  update_user_set () {}

}

function ensure_time (time, now) {
  if (time === undefined || time === null) {
    return Number.isInteger(now) ? now : Date.now();
  }
  else if (Number.isInteger(time)) {
    return time;
  }
  const t = new Date(time).getTime();
  return Number.isNaN(t) ? null : t;
}

module.exports = UserDB;
