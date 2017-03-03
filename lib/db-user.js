'use strict';

const _ = require('lodash');
const path = require('path');
const BaseDB = require('./db-base');
const iterwait = require('./iterwait');
// const { decompose, recombine } = require('./parsecfg');

class UserDB extends BaseDB {

  constructor (filename, user_id, options = {}) {
    if (!filename) {
      throw new Error('No filename given');
    }
    if (!user_id) {
      throw new Error('No user id given');
    }

    super(filename, _.pick(options, ['create_file', 'single_conn']));

    this.id_str = String(user_id);
  }

  static open (filename, user_id, options = {}) {
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
          new UserDB(filename, user_id, options)
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
      const user_id = _.get(this.config, 'user.id_str', null);
      if (this.id_str !== user_id) {
        if (user_id === null) {
          yield this.set_config(this.id_str, 'user.id_str', { trx });
        }
        else {
          throw new Error(
            `Given user id "${this.id_str}" doesn't match user id in db "${user_id}"`
          );
        }
      }

      // TODO: load usersets

      return this;
    }, { start_trx: true });
  }


}

module.exports = UserDB;
