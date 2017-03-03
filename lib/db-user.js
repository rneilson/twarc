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

  get_user () {}

  write_user () {}

  write_user_set () {}

  update_user_set () {}

  write_tweet () {}

  delete_tweet () {}

  write_alias (alias, { cache = null, trx = null }) {
    if (!_.isObject(alias) && !_.isArray(alias)) {
      return Promise.reject(new Error(`Invalid alias: ${alias}`));
    }
    const aliases = _.isArray(alias) ? alias : [alias];

    return this.run_async(function* _write_alias(conn) {
      // Prepare statement
      const use_cache = cache || new StatementCache(conn);
      const { insert } = yield use_cache.load(
        {
          insert: `INSERT OR IGNORE
INTO alias (user_id, screen_name, time_ms)
VALUES (?, ?, ?)`,
        },
        'alias'
      );

      // Insert each
      const now = Date.now();
      const results = yield Promise.all(aliases.map(
        ({ user_id_str, screen_name, time }) => {
          const use_time = (time === undefined || time === null)
            ? now
            : Number.isInteger(time)
              ? time
              : new Date(time).getTime();

          // user_id/screen_name check constraint will skip insert
          return insert.run([user_id_str, screen_name, use_time])
          .then(({ changes }) => [user_id_str, screen_name, !!changes]);
        }
      ));

      // Finalize statements if not using provided cache
      if (!cache) {
        yield use_cache.finalize();
      }

      return results;
    }, { use_conn: trx, start_trx: true});
  }

  write_mention () {}

  write_fav () {}

  delete_fav () {}

}

module.exports = UserDB;
