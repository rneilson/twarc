'use strict';

const fs = require('fs');
const { expect } = require('chai');
const { decompose, recombine } = require('../lib/parsecfg');
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

    let db;

    before(function () {
      db = new BaseDB('./test/data/db-base.db', {
        create_file: true,
        single_conn: true
      });

      return db.db.migrate({migrationsPath: './test/migrations/db-base'});
    });

    it('should get a single value for a single key', function () {
      return db.getconfig('app.test1').then((val) => {
        expect(val).to.be.true;
      })
    });

    it('should get an object value for a key prefix', function () {
      return db.getconfig('dir').then((obj) => {
        expect(obj).to.deep.equal({
          test: './test/',
          sql: './test/migrations/db-base/'
        });
      });
    });

    it('should get all values as an object for an empty key', function () {
      return db.getconfig().then((obj) => {
        expect(obj).to.deep.equal({
          app: {
            test1: true,
            test2: false,
            test3: null,
            obj: {
              test1: 'beep',
              test2: 'boop',
              test3: ['beep', 'boop']
            }
          },
          dir: {
            test: './test/',
            sql: './test/migrations/db-base/'
          }
        });
      });
    });

    it('should return a [value, time] array when time is true', function () {
      return db.getconfig('app.test1', true).then((val) => {
        expect(val).to.deep.equal([true, 1488210932000]);
      });
    });

    after(function () {
      return db.close();
    });

  });

  describe('setconfig()', function () {

    let db;

    before(function () {
      db = new BaseDB('./test/data/db-base.db', {
        single_conn: true
      });

      return db.db.migrate({migrationsPath: './test/migrations/db-base'});
    });

    it('should update a single value for a single key', function () {
      return db.setconfig('./test/data/', 'dir.test').then((chg) => {
        expect(recombine(chg, 'dir.test')).to.be.true;
      })
      .then(() => db.getconfig('dir.test'))
      .then((val) => {
        expect(val).to.equal('./test/data/');
      });
    });

    it('should update multiple values for a prefix key', function () {
      return db.setconfig(
        {
          test1: 'boop',
          test2: 'beep',
          test3: ['boop', 'beep']
        },
        'app.obj'
      )
      .then((chg) => {
        expect(recombine(chg, 'app.obj')).to.deep.equal({
          test1: true,
          test2: true,
          test3: true
        });
      })
      .then(() => db.getconfig('app.obj'))
      .then((val) => {
        expect(val).to.deep.equal({
          test1: 'boop',
          test2: 'beep',
          test3: ['boop', 'beep']
        });
      });
    });

    it('should insert a new key for a new single value', function () {
      return db.getconfig('app.test4').then((val) => {
        expect(val).to.be.undefined;
      })
      .then(() => db.setconfig(10, 'app.test4'))
      .then((chg) => {
        expect(recombine(chg, 'app.test4')).to.be.true;
      })
      .then(() => db.getconfig('app.test4'))
      .then((val) => {
        expect(val).to.equal(10);
      });
    });

    it('should insert multiple new keys for a new object value', function () {
      return db.getconfig('test').then((val) => {
        expect(val).to.be.undefined;
      })
      .then(() => db.setconfig(
        {
          beep: 2,
          boop: '3'
        },
        'test'
      ))
      .then((chg) => {
        expect(recombine(chg, 'test')).to.deep.equal({
          beep: true,
          boop: true
        });
      })
      .then(() => db.getconfig('test'))
      .then((val) => {
        expect(val).to.deep.equal({
          beep: 2,
          boop: '3'
        });
      });
    });

    it('should not update a value when the existing time is later', function () {
      return db.setconfig(1, 'app.test1', 1488210931999).then((chg) => {
        expect(recombine(chg, 'app.test1')).to.be.false;
      })
      .then(() => db.getconfig('app.test1', true))
      .then((val) => {
        expect(val).to.deep.equal([true, 1488210932000]);
      })
      .then(() => db.setconfig([1, 1488210931999], 'app.test1', true))
      .then((chg) => {
        expect(recombine(chg, 'app.test1')).to.be.false;
      })
      .then(() => db.getconfig('app.test1', true))
      .then((val) => {
        expect(val).to.deep.equal([true, 1488210932000]);
      });
    });

    it('should not insert a key conflicting with an existing prefix', function () {
      return db.setconfig(5, 'test').catch((e) => {
        expect(e).to.be.an('error');
        expect(e.message).to.match(/already a prefix/i);
      })
      .then(() => db.getconfig('test'))
      .then((val) => {
        expect(val).to.deep.equal({
          beep: 2,
          boop: '3'
        });
      });
    });

    it('should not update a value when undefined', function () {
      return db.getconfig('app.test4').then((val) => {
        expect(val).to.equal(10);
      })
      .then(() => db.setconfig(undefined, 'app.test4'))
      .then((chg) => {
        expect(recombine(chg, 'app.test4')).to.be.false;
      })
      .then(() => db.getconfig('app.test4'))
      .then((val) => {
        expect(val).to.equal(10);
      })
    });

    after(function () {
      return db.close();
    });

  });

  describe('delconfig()', function () {

    let db;

    before(function () {
      db = new BaseDB('./test/data/db-base.db', {
        single_conn: true
      });

      return db.db.migrate({migrationsPath: './test/migrations/db-base'});
    });

    it('should delete a single key', function () {
      return db.getconfig('app.test4').then((val) => {
        expect(val).to.equal(10);
      })
      .then(() => db.delconfig('app.test4'))
      .then((chg) => {
        expect(chg).to.be.true;
      })
      .then(() => db.getconfig('app.test4'))
      .then((val) => {
        expect(val).to.be.undefined;
      })
      .then(() => db.getconfig('app'))
      .then((val) => {
        expect(val).to.deep.equal({
          test1: true,
          test2: false,
          test3: null,
          obj: {
            test1: 'boop',
            test2: 'beep',
            test3: ['boop', 'beep']
          }
        });
      });
    });

    it('should not delete a key when the existing time is later', function () {
      return db.getconfig('app.test1', true).then((val) => {
        expect(val).to.deep.equal([true, 1488210932000]);
      })
      .then(() => db.delconfig('app.test1', 1488210931999))
      .then((chg) => {
        expect(chg).to.be.false;
      })
      .then(() => db.getconfig('app.test1', true))
      .then((val) => {
        expect(val).to.deep.equal([true, 1488210932000]);
      });
    });

    it('should delete multiple keys when given prefix', function () {
      return db.getconfig('app').then((val) => {
        expect(val).to.deep.equal({
          test1: true,
          test2: false,
          test3: null,
          obj: {
            test1: 'boop',
            test2: 'beep',
            test3: ['boop', 'beep']
          }
        });
      })
      .then(() => db.delconfig('app.obj'))
      .then((chg) => {
        expect(chg).to.be.true;
      })
      .then(() => db.getconfig('app'))
      .then((val) => {
        expect(val).to.deep.equal({
          test1: true,
          test2: false,
          test3: null
        });
      });
    });

    it('should not delete any prefixed keys if any time is later', function () {
      return db.getconfig('dir').then((val) => {
        expect(val).to.deep.equal({
          test: './test/data/',
          sql: './test/migrations/db-base/'
        });
      })
      .then(() => db.delconfig('dir', 1488210932000))
      .then((chg) => {
        expect(chg).to.be.false;
      })
      .then(() => db.getconfig('dir'))
      .then((val) => {
        expect(val).to.deep.equal({
          test: './test/data/',
          sql: './test/migrations/db-base/'
        });
      });
    });

    after(function () {
      return db.close();
    });

  });

  describe('runasync()', function () {

    it('should acquire a connection by default');

    it('should start a transaction when start_trx is true');

    it('should use a given existing transaction');

    it('should use the base Sqlite object when use is false');

  });

});
