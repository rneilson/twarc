'use strict';

const _ = require('lodash');

class StatementCache {

  constructor (conn) {
    if (!conn) {
      throw new Error('No database connection given');
    }
    this._conn = conn;
    this.statements = new Map();
  }

  _prepare (sql, params = []) {
    // Prepare new statement, add to cache
    return this._conn.prepare(sql, ...params).then((stmt) => {
      // Add dummy prop to prevent premature finalization
      stmt.finalize = function () {
        return this.Promise.resolve();
      };

      // Add to cache
      this.statements.set(sql, stmt);

      return stmt;
    });
  }

  prepare (sql, ...params) {
    const cached = this.statements.get(sql);

    if (cached) {
      // Bind new parameters if given, or reset if not
      // This ensures a .get() call on a cached statement
      // won't return the *next* row instead -- calling
      // conn.prepare() implies a fresh start is expected
      return params.length ? cached.bind(...params) : cached.reset();
    }

    return this._prepare(sql, params);
  }

  finalize () {
    const stmts = [];
    for (const stmt of this.statements.values()) {
      // Remove dummy prop
      delete stmt.finalize;
      // Actually finalize now
      stmts.push(stmt.finalize());
    }
    return this._conn.Promise.all(stmts);
  }

  get (sql, ...params) {
    const cached = this.statements.get(sql);
    const fn = stmt => stmt.get(...params);

    return cached
      ? params.length
        ? fn(cached)                  // If params given, will be reset automatically
        : cached.reset().then(fn)     // If no params given, have to reset first
      : this._prepare(sql).then(fn);
  }

  all (sql, ...params) {
    const cached = this.statements.get(sql);
    const fn = stmt => stmt.all(...params);

    return cached ? fn(cached) : this._prepare(sql).then(fn);
  }

  each (sql, ...params) {
    if (params.length < 1) {
      throw new Error('Callback argument is required');
    }
    const callback = params.pop();
    const cached = this.statements.get(sql);
    const fn = stmt => stmt.each(...params, callback);

    return cached ? fn(cached) : this._prepare(sql).then(fn);
  }

  run (sql, ...params) {
    const cached = this.statements.get(sql);
    const fn = stmt => stmt.run(...params);

    return cached ? fn(cached) : this._prepare(sql).then(fn);
  }

  exec (sql) {
    return this._conn.exec(sql).then(() => this);
  }

  wait () {
    return this._conn.wait();
  }

  transaction (fn, ...args) {
    return this._conn.transaction(
      (trx) => {
        const cache = new this.constructor(trx);
        return trx.Promise.resolve(fn.call(this, cache))
        .then(result => cache.finalize.then(() => result));
      },
      ...args
    );
  }

  transactionAsync (gen, ...args) {
    return this._conn.transaction(
      (trx) => {
        const cache = new this.constructor(trx);
        return this._conn._async.call(this, gen, cache)
        .then(result => cache.finalize.then(() => result));
      },
      ...args
    );
  }

}

module.exports = StatementCache;
