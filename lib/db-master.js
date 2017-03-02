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

    if (_.get(options, 'migrate', true)) {
      const migrate_opts = {
        force: _.get(options, 'force', false),
        migrationsPath: path.join(__dirname, '../migrations/master'),
      };
      p = p.then(master => master.db.migrate(migrate_opts).then(() => master));
    }

    if (_.get(options, 'init', true)) {
      p = p.then(master => master._init());
    }

    return p;
  }

  /**
   *  Populates config, logtype caches
   */
  _init () {
    return this.run_async(function* (conn) {
      // get_config() will update cache itself
      yield this.get_config();

      // Fetch log types and put into cache
      const log_type = yield this.db.all(`SELECT * FROM log_type`);

      // Cache log types by code and label
      for (const type of log_type) {
        this.log_type.set(type.code, type);
        this.log_type.set(type.label, type);
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
   *  Fetches user db data for display, launch
   */
  user_data (user_id, { is_active, trx = null } = {}) {
    const columns = [
      'CAST(id AS TEXT) AS id_str',
      'name',
      'screen_name',
      'db_path',
      'access_token_key',
      'access_token_secret',
      'is_active',
      'last_opened_ms'
    ];
    const select = `SELECT ${columns.join(', ')} FROM user_db`;

    // Build conditions
    const where = [];
    const params = [];
    if (user_id) {
      where.push('id = ?');
      params.push(user_id);
    }
    if (is_active === true) {
      where.push('is_active');
    }
    else if (is_active === false) {
      where.push('NOT is_active');
    }
    // TODO: since/until?

    // Return query
    const db = trx || this.db;
    return where.length
      ? db.all(`${select} WHERE ${where.join(' AND ')}`, params)
      : db.all(select);
  }

  /**
   *
   */
  user_open (user_id, { time, trx = null } = {}) {
    if (!_.isString(user_id) && !_.isInteger(user_id)) {
      return Promise.reject(new Error(`Invalid user_id: ${user_id}`));
    }

    const update = `UPDATE user_db
SET is_active = 1, last_opened_ms = ?
WHERE id = ?`;
    const params = [(time ? new Date(time).getTime() : Date.now()), user_id];
    const query = conn => conn.run(update, params).then(({ changes }) => !!changes);

    return trx
      ? query(trx)
      : this.db.transaction(_trx => query(_trx));
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
