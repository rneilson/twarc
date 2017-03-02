'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { decompose, recombine } = require('../lib/parsecfg');
const MasterDB = require('../lib/db-master');

describe('MasterDB', function () {

  describe('open()', function () {

    function clean_db () {
      // Delete existing database file, if any
      for (let ext of ['db', 'db-shm', 'db-wal']) {
        try {
          fs.unlinkSync(`./test/data/db-master.${ext}`);
        }
        catch (e) {
          if (e.code !== 'ENOENT') {
            throw e;
          }
        }
      }
    }

    before(clean_db);

    const filename = './test/data/db-master.db';
    let master;

    it('should reject when create_file is false and file missing', function () {
      return MasterDB.open(filename, { create_file: false}).then(() => {
        throw new Error('File was not supposed to be opened');
      })
      .catch((e) => {
        expect(e).to.be.an('error');
        expect(e).to.have.property('code');
        expect(e.code).to.equal('SQLITE_CANTOPEN');
      });
    });

    it('should return an instance of MasterDB', function () {
      return MasterDB.open(filename).then((db) => {
        expect(db).to.be.an.instanceof(MasterDB);
        master = db;
      });
    });

    it('should create a missing file by default', function () {
      const exists = fs.existsSync(path.resolve(filename));
      expect(exists).to.be.true;
    });

    it('should perform pending migrations by default', function () {
      return master.db.all(
        `SELECT id FROM migrations ORDER BY id ASC`
      )
      .then((migrations) => {
        expect(migrations).to.be.an.instanceof(Array);
        expect(migrations).to.have.length.of.at.least(1);
      });
    });

    it('should have initialized config data/log types by default', function () {
      const cfgkeys = Object.keys(master.config);
      expect(cfgkeys).to.be.an.instanceof(Array);
      expect(cfgkeys).to.have.length.of.at.least(1);

      const logkeys = Array.from(master.log_type.keys());
      expect(logkeys).to.be.an.instanceof(Array);
      expect(logkeys).to.have.length.of.at.least(1);
    });

    after(function () {
      const p = master
        ? master.close()
        : Promise.resolve();
      return p.then(clean_db);
    });

  });

  describe('Instance methods', function () {

    describe('new_user()', function () {});

    describe('user_data()', function () {});

    describe('user_activate()', function () {});

    describe('write_log()', function () {});

  });

});

