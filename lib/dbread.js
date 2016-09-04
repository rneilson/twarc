'use strict';

const _ = require('lodash');
const path = require('path');
const lmdb = require('../node-lmdb');
// const Filters = require('./filters.js');

// Config
const defaultopts = {
	mapSize: 1 * 1024 * 1024 * 1024,	// 1 GiB
	maxDbs: 10,
	maxReaders: 8,
	// noSync: true,
	// noMetaSync: true,
};
const dbnames = ['status', 'users', 'screennames', 'tweets', 'userdates', 'otherdates', 'favids', 'favdates', 'urls', 'media'];

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

		// Open database
		this.env = new lmdb.Env();
		this.env.open(this.options);
		this.dbs = {};
		for (let name of dbnames) {
			this.dbs[name] = this.env.openDbi({name, create: true});
		}

		// Check user id
		let userst = this.getstatus('user.id_str');
		if (userst !== null && userst != this.user_id_str) {
			throw new Error("User id string given doesn't match database value");
		}
	}

	static defaultoptions () {
		return defaultopts;
	}

	static dbnamelist () {
		return dbnames;
	}

	close () {
		for (let name of dbnames) {
			this.dbs[name].close();
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
				cur.getCurrentBinaryUnsafe((k, v) => {
					let sv = JSON.parse(v.toString());
					val = raw ? sv : sv[1];
				});
			}
			else if (key.startsWith(pre) && key.length > pre.length) {
				// DEBUG
				// console.log(`Looking for ${name}, Found prefixed key ${key}`);
				// Key is path prefix, gather all prefixed keys into composite object
				val = {};
				do {
					cur.getCurrentBinaryUnsafe((k, v) => {
						// Get/make property path
						let p = k.split('.');
						// Remove prefix
						if (pre) {
							p.shift();
						}
						// Set property at path
						if (p.length > 0) {
							let sv = JSON.parse(v.toString());
							_.set(val, p, raw ? sv : sv[1]);
							// DEBUG
							// console.log(`Set ${p.join('.')} to ${v}`);
						}
					});
					key = cur.goToNext();
				} while (key && key.startsWith(pre) && key.length > pre.length);
			}
			else {
				// No matching or prefixed keys, do nothing
			}

			cur.close();
			if (closetxn) {
				txn.commit();
			}
		}
		catch (e) {
			cur.close();
			if (closetxn) {
				txn.abort();
				val = null;
			}
			throw e;
		}

		return val;
	}

	hastweet (id, txn) {
		let haskey = false;

		let closetxn = false;
		if (!txn) {
			// No transaction given, start a new one
			txn = this.env.beginTxn({readOnly: true});
			closetxn = true;
		}

		let cur = new lmdb.Cursor(txn, this.dbs.tweets);
		try {
			let key = cur.goToKey(id);
			if (key !== null) {
				haskey = true;
			}
			cur.close();
			if (closetxn) {
				txn.commit();
			}
		}
		catch (e) {
			cur.close();
			if (closetxn) {
				txn.abort();
				haskey = false;
			}
			throw e;
		}

		return haskey;
	}
}

module.exports = DBReader;
