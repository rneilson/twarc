'use strict';

const _ = require('lodash');
const path = require('path');
const lmdb = require('node-lmdb');
// const Filters = require('./filters.js');

// Config
const defaultopts = {
	mapSize: 1 * 1024 * 1024 * 1024,	// 1 GiB
	maxDbs: 12,
	maxReaders: 8,
	// noSync: true,
	// noMetaSync: true,
};
const dbstores = ['status', 'users', 'tweets', 'favids'];
const dbindices = ['names', 'userdates', 'otherdates', 'favdates', 'refs'];
const dbnames = dbstores.concat(dbindices);

// Internal method symbols
const _iter = Symbol('iter');

class DBReader {

	constructor (options) {
		this.options = _.defaultsDeep({}, options, defaultopts);

		// Ensure user id and db path given
		if (!_.has(options, 'user_id_str')) {
			throw new Error('No user id string given');
		}
		if (!_.has(options, 'path')) {
			throw new Error('No database path given');
		}

		// Remove user id from options, store on its own
		this.user_id_str = this.options.user_id_str;
		delete this.options.user_id_str;

		// Resolve path
		this.options.path = path.resolve(this.options.path);

		// Open environment
		this.env = new lmdb.Env();
		this.env.open(this.options);

		// Open databases
		this.dbs = {};
		this.stores = new Set();
		for (let name of dbstores) {
			// Open db and add to appropriate sections
			let db = this.env.openDbi({name, create: true});
			this.dbs[name] = db;
			this.stores.add(db);
			// Add name
			db.name = name;
			// Add shortcuts for iterators
			db.keys = this.keys.bind(this, db);
			db.values = this.values.bind(this, db);
			db.entries = this.entries.bind(this, db);
		}
		this.indices = new Set();
		for (let name of dbindices) {
			// Open db and add to appropriate sections
			let db = this.env.openDbi({name, create: true, dupSort: true});
			this.dbs[name] = db;
			this.indices.add(db);
			// Add name
			db.name = name;
			// Add shortcuts for iterators
			db.keys = this.keys.bind(this, db);
			db.values = this.values.bind(this, db);
			db.entries = this.entries.bind(this, db);
		}

		// Check user id
		let userst = this.getstatus('user.id_str');
		if (userst !== null && userst != this.user_id_str) {
			throw new Error(`Given user id "${this.user_id_str}" doesn't match user id in database "${userst}"`);
		}
	}

	static defaultoptions () {
		return defaultopts;
	}

	static dbnamelist () {
		return dbnames;
	}

	static dbstorelist () {
		return dbstores;
	}

	static dbindexlist () {
		return dbindices;
	}

	close () {
		for (let db of this.stores) {
			db.close();
		}
		for (let db of this.indices) {
			db.close();
		}
		this.env.close();
	}

	begin () {
		return this.env.beginTxn({readOnly: true});
	}

	datestr (d) {
		let dt = d ? new Date(d) : new Date();
		return _.replace(dt.toISOString(), /[^0-9]/g, '');
	}

	getstatus (name, raw, txn) {
		let val = null;
		let pre = name ? name + '.' : '';
		let closetxn = false;

		if (!txn) {
			// No transaction given, start a new one
			txn = this.env.beginTxn({readOnly: true});
			closetxn = true;
		}

		let cur = new lmdb.Cursor(txn, this.dbs.status);
		try {
			let key = name ? cur.goToRange(name) : cur.goToFirst();
			if (key === null) {
				// No matching or prefixed keys, do nothing
			}
			else if (key == name) {
				// Single key, not a path prefix
				let sv = JSON.parse(cur.getCurrentBinaryUnsafe().toString());
				val = raw ? sv : sv[1];
			}
			else if (key.startsWith(pre) && key.length > pre.length) {
				// DEBUG
				// console.log(`Looking for ${name}, Found prefixed key ${key}`);
				// Key is path prefix, gather all prefixed keys into composite object
				val = {};
				do {
					// Get/make property path
					let p = key.split('.');
					// Remove prefix
					if (pre) {
						p.shift();
					}
					// Set property at path
					if (p.length > 0) {
						let sv = JSON.parse(cur.getCurrentBinaryUnsafe().toString());
						_.set(val, p, raw ? sv : sv[1]);
						// DEBUG
						// console.log(`Set ${p.join('.')} to ${v}`);
					}
					key = cur.goToNext();
				} while (key && key.startsWith(pre) && key.length > pre.length);
			}
			else {
				// No matching or prefixed keys, do nothing
			}

			cur.close();
			cur = null;
			if (closetxn) {
				txn.commit();
			}
		}
		catch (e) {
			if (cur) {
				cur.close();
			}
			if (closetxn) {
				txn.abort();
				val = null;
			}
			throw e;
		}

		return val;
	}

	haskey (db, id, txn) {
		let has = false;
		db = _.isString(db) ? this.dbs[db] : db;

		let closetxn = false;
		if (!txn) {
			// No transaction given, start a new one
			txn = this.env.beginTxn({readOnly: true});
			closetxn = true;
		}

		let cur = new lmdb.Cursor(txn, db);
		try {
			let key = cur.goToKey(id);
			if (key !== null) {
				has = true;
			}
			cur.close();
			cur = null;
			if (closetxn) {
				txn.commit();
			}
		}
		catch (e) {
			if (cur) {
				cur.close();
			}
			if (closetxn) {
				txn.abort();
				has = false;
			}
			throw e;
		}

		return has;
	}

	hastweet (id, txn) {
		return this.haskey('tweets', id, txn);
	}

	keys (db, opts) {
		opts = opts || {};
		return this[_iter]('keys', db, opts.start, opts.end, opts.count, opts.reverse, opts.txn);
	}

	values (db, opts) {
		opts = opts || {};
		return this[_iter]('values', db, opts.start, opts.end, opts.count, opts.reverse, opts.txn);
	}

	entries (db, opts) {
		opts = opts || {};
		return this[_iter]('entries', db, opts.start, opts.end, opts.count, opts.reverse, opts.txn);
	}

	/* Private methods */

	[_iter] (type, db, start, end, count, reverse, txn) {
		// Sanity checks
		if (!db || !((_.isString(db) && _.has(this.dbs, db)) || this.stores.has(db) || this.indices.has(db))) {
			throw new Error("Invalid db given: " + _.toString(db));
		}
		if (start && !_.isString(start)) {
			throw new Error("'start' must be a string, given: " + _.toString(start));
		}
		if (end && !_.isString(end)) {
			throw new Error("'end' must be a string, given: " + _.toString(end));
		}
		if (count && !_.isNumber(count) && count > 0) {
			throw new Error("'count' must be a positive integer, given: " + _.toString(count));
		}
		if (reverse && reverse !== true) {
			throw new Error("'reverse' must be a boolean, given: " + _.toString(reverse));
		}

		db = _.isString(db) ? this.dbs[db] : db;

		var closetxn = false;
		if (!txn) {
			// No transaction given, start a new one
			txn = this.env.beginTxn({readOnly: true});
			closetxn = true;
		}

		return iter(this.indices.has(db));

		function* iter (isindex) {
			try {
				// End-checker function
				var num = 0;
				var check = null;
				if (count || end) {
					check = (reverse)
						? () => ((!count || num++ < count) && (!end || key >= end))
						: () => ((!count || num++ < count) && (!end || key < end));
				}

				// Yield-value function
				var keyonly = false;
				var ret;
				switch(type) {
					case 'keys':
						keyonly = true;
						ret = (k, c) => k;
						break;
					case 'values':
						ret = (isindex)
							? (k, c) => c.getCurrentString()
							: (k, c) => JSON.parse(c.getCurrentBinaryUnsafe().toString());
						break;
					case 'entries':
						ret = (isindex)
							? (k, c) => [k, c.getCurrentString()]
							: (k, c) => [k, JSON.parse(c.getCurrentBinaryUnsafe().toString())];
						break;
					default:
						throw new Error("Unknown iterator type requested: " + type);
				}

				// Find start point
				var cur = new lmdb.Cursor(txn, db);
				var key;
				if (start) {
					key = cur.goToRange(start);
					if (reverse) {
						key = cur.goToPrev();
					}
				}
				else {
					key = (reverse) ? cur.goToLast() : cur.goToFirst();
				}

				// Actually iterate now
				while (key && (!check || check())) {
					if (isindex) {
						while (key) {
							yield ret(key, cur);
							key = (reverse) ? cur.goToPrevDup() : cur.goToNextDup();
						}
					}
					else {
						yield ret(key, cur);
					}
					key = (reverse) ? cur.goToPrev() : cur.goToNext();
				}

				cur.close();
				cur = null;
				if (closetxn) {
					txn.commit();
				}
			}
			catch (e) {
				if (cur) {
					cur.close();
				}
				if (closetxn) {
					txn.abort();
				}
				throw e;
			}
		}
	}

}

module.exports = DBReader;
