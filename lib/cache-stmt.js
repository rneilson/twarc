'use strict';

const _ = require('lodash');
const { decompose, recombine } = require('./parsecfg');

class StatementCache {

  constructor (conn) {
    if (!conn) {
      throw new Error('No database connection given');
    }
    this._conn = conn;
    this._stmt = {};
  }

  has (name) {
    return name ? _.has(this._stmt, name) : false;
  }

  get (name) {
    return name ? _.get(this._stmt, name, null) : null;
  }

  load (statements = {}, prefix = '') {
    const stmts = !prefix && _.isArray(statements)
      ? statements
      : decompose(statements, prefix);

    return Promise.all(stmts.map(([name, sql]) => {
      if (!name || !sql) {
        throw new Error(`Invalid name, sql pair: ['${name}', '${sql}']`);
      }
      // Get cached
      const stmt = _.get(this._stmt, name);
      if (stmt) {
        // This *shouldn't* happen, but might
        if (stmt.sql != sql) {
          throw new Error(
            `Prepared statement at '${name}' has SQL '${stmt.sql}', not '${sql}'`
          );
        }
        // Already have, good to go
        return [name, stmt];
      }
      // Prepare each statement and update cache
      return this._conn.prepare(sql).then((p_stmt) => {
        _.set(this._stmt, name, p_stmt);
        return [name, p_stmt];
      });
    }))
    .then(pairs => recombine(pairs, prefix));
  }

  finalize (prefix = '') {
    return Promise.all(
      decompose(this._stmt, prefix).map(([name, stmt]) => stmt.finalize())
    )
    .then(() => {
      if (prefix) {
        _.unset(this._stmt, prefix);
      }
      else {
        this._stmt = {};
      }
    });
  }

}

module.exports = StatementCache;
