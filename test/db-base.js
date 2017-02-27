'use strict';

const fs = require('fs');
const { expect } = require('chai');
const BaseDB = require('../lib/db-base');

describe('BaseDB', function () {

  after(function () {

    // Delete existing database file, if any
    for (let file of ['db-base.db', 'db-base.db-shm', 'db-base.db-wal']) {
      try {
        fs.unlinkSync(`./test/data/${file}`);
      }
      catch (e) {
        if (e.code !== 'ENOENT') {
          throw e;
        }
      }
    }

  });

  describe('new ()', function () {

    it('should emit an error when opening a nonexistent file', function (done) {

      const db = new BaseDB('./test/data/db-base.db', {
        single_conn: true
      });

      let err;

      db.once(
        'open:success',
        (file) => db.close().then(() => done(new Error(`Shouldn't open: ${file}`)))
      );
      db.once('open:error', () => db.close().then(() => done()));

    });

    it('should emit an open event after creating a file', function (done) {

      const db = new BaseDB('./test/data/db-base.db', {
        create_file: true,
        single_conn: true
      });

      let err;

      db.once('open:success', () => db.close().then(() => done()));
      db.once('open:error', err => db.close().then(() => done(err)));

    });

    it('should emit an open event after opening an existing file', function (done) {

      const db = new BaseDB('./test/data/db-base.db', {
        single_conn: true
      });

      let err;

      db.once('open:success', () => db.close().then(() => done()));
      db.once('open:error', err => db.close().then(() => done(err)));

    });

  });

  describe('getconfig()', function () {

    it('should get a single value for a single key');

    it('should get an object value for a key prefix');

    it('should get all values as an object for an empty key');

    it('should return a [value, time] array when time is true');

  });

  describe('setconfig()', function () {

    it('should update a single value for a single key');

    it('should update multiple values for a prefix key');

    it('should insert a new key for a new single value');

    it('should insert multiple new keys for a new object value');

    it('should not update a value when the existing time is later');

    it('should not insert a new key conflicting with an existing prefix');

  });

  describe('runasync()', function () {

    it('should acquire a connection by default');

    it('should start a transaction when start_trx is true');

    it('should use a given existing transaction');

    it('should use the base Sqlite object when use is false');

  });

});
