'use strict';

const _ = require('lodash');
const path = require('path');
const lmdb = require('../node-lmdb');
const Filters = require('./filters.js');

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

	constructor (options, errfn) {
		this.options = _.defaultsDeep({}, options, defaultopts);
		this.err = _.isFunction(errfn) ? errfn : console.error.bind(console);

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

	getstatus (name) {
		let txn = this.env.beginTxn({readOnly: true});
		let cur = new lmdb.Cursor(txn, dbs.status);
		let val = null;
		let pre = name + '.';

		try {
			let key = cur.goToKey(name);
			if (key === null) {
				// No matching or prefixed keys, do nothing
			}
			else if (key == name) {
				// Single key, not a path prefix
				cur.getCurrentBinaryUnsafe((k, v) => {
					val = JSON.parse(v.toString());
				});
			}
			else if (key.startsWith(pre) && key.length < pre.length) {
				// Key is path prefix, gather all prefixed keys into composite object
				val = {};
				do {
					cur.getCurrentBinaryUnsafe((k, v) => {
						// Get/make property path
						let p = k.split('.');
						// Remove prefix
						p.shift();
						// Set property at path
						if (p.length > 0) {
							_.set(val, p, JSON.parse(v.toString()));
						}
					});
					key = cur.goToNext();
				} while (key.startsWith(pre));
			}
			else {
				// No matching or prefixed keys, do nothing
			}

			cur.close();
			txn.commit();
		}
		catch (e) {
			cur.close();
			txn.abort();
			throw e;
		}

		return val;
	}

	// TODO: move to DBWriter instead?
	setstatus (name, val) {
		let txn = this.env.beginTxn();
		let dbt = this.dbs.status;
		let cur = new lmdb.Cursor(txn, dbt);
		let ret = true;
		let toset = [];

		if (_.isObjectLike(val) && !_.isArray(val)) {
			// TODO: decompose
		}
		else {
			toset.push([name, new Buffer(JSON.stringify(val))])
		}

		try {
			// Put each decomposed key/val pair
			for (let i = 0, len_i = toset.length; i < len_i; i++) {
				txn.putBinary(dbt, toset[0], toset[1]);
			}

			cur.close();
			txn.commit();
		}
		catch (e) {
			cur.close();
			txn.abort();
			throw e;
		}

		return ret;
	}
}

module.exports = DBReader;
