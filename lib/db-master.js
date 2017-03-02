'use strict';

const _ = require('lodash');
const path = require('path');
const BaseDB = require('./db-base');
// const iterwait = require('./iterwait');
// const { decompose, recombine } = require('./parsecfg');

class MasterDB extends BaseDB {

  constructor (filename, options) {
    super(filename, {
      create_file: _.get(options, 'create_file', true),
      single_conn: _.get(options, 'single_conn', true),
    });

    // Log type cache
    this.log_type = new Map();
  }

  static open (filename, options) {
    const db_opts = _.pick(options, ['create_file', 'single_conn']);
    const migrate = _.get(options, 'migrate', true);
    const migrate_opts = {
      force: _.get(options, 'force', false),
      migrationsPath: path.join(__dirname, '../migrations/master'),
    };

    let p = new Promise((resolve, reject) => {
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
      new MasterDB(filename, db_opts)
        .once('open:success', on_open)
        .once('open:error', on_err);
    });

    if (migrate) {
      p = p.then(master => master.db.migrate(migrate_opts).then(() => master));
    }

    return p.then(master => master._init());
  }

  /**
   *  Populates config, logtype caches
   */
  _init () {
    return this.run_async(function* (conn) {
      // get_config() will update cache itself
      const [ cfg, log_type ] = yield Promise.all([
        this.get_config(),
        this.db.all(`SELECT * FROM log_type`)
      ]);

      // Cache log types by code and label
      for (const type of log_type) {
        this.log_type.set(type.code, type);
        this.log_type.set(type.label, type);
      }

      // Log init as event
      if (this.log_type.get('event').to_db) {
        yield this.write_log(
          'Initialized master db',
          {
            type: 'event',
            proc_name: process.env.PROC_NAME || 'master'
          }
        );
      }

      return this;
    });
  }

  /**
   *  Creates new user entry
   */
  new_user () {

  }

  /**
   *  Fetches user id, name, screen name, db path for display
   */
  user_info () {

  }

  /**
   *  Fetches user id, db_path, access token for launching
   */
  user_auth () {

  }

  /**
   *  Writes log entry to db according to entry type
   */
  write_log (message, options) {
    const time = _.get(options, 'time', Date.now());
    const user_id = _.get(options, 'user_id', null);
    const proc_name = _.get(options, 'proc_name', null);

    const type_ref = _.has(options, 'type')
      ? options.type
      : this.config.log.default_type;
    const type = this.log_type.get(type_ref);

    // Double-check if type is valid
    if (type === undefined) {
      // Not found, emit warning and reject
      const warn_str = `Invalid log type ${type_ref}: ${message}`;
      this.emit('warning', warn_str);
      return Promise.reject(new Error(warn_str));
    }

    // Insert into db
    return this.db.run(
      `INSERT INTO log_data (time_ms, type_code, user_id, proc_name, message)
VALUES (?, ?, ?, ?, ?)`, [time, type.code, user_id, proc_name, message]
    )
    .then(({ changes }) => !!changes);
  }

}

module.exports = MasterDB;
