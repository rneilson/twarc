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

	getstatus (name, txn) {
		let val = null;
		let pre = name + '.';
		let closetxn = false;

		if (!txn) {
			// No transaction given, start a new one
			txn = this.env.beginTxn({readOnly: true});
			closetxn = true;
		}

		let cur = new lmdb.Cursor(txn, this.dbs.status);
		try {
			let key = cur.goToRange(name);
			if (key === null) {
				// No matching or prefixed keys, do nothing
			}
			else if (key == name) {
				// Single key, not a path prefix
				cur.getCurrentBinaryUnsafe((k, v) => {
					val = JSON.parse(v.toString());
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
						p.shift();
						// Set property at path
						if (p.length > 0) {
							_.set(val, p, JSON.parse(v.toString()));
							// DEBUG
							// console.log(`Set ${p.join('.')} to ${v}`);
						}
					});
					key = cur.goToNext();
				} while (key && key.startsWith(pre));
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

	// TODO: move to DBWriter instead?
	setstatus (name, val, txn) {
		let dbt = this.dbs.status;
		let ret = true;
		// let toset = [];
		let closetxn = false;

		if (!txn) {
			// No transaction given, start a new one
			txn = this.env.beginTxn();
			closetxn = true;
		}

		// Decompose object, stringify value(s)
		// 'toset' is array of key/value pairs to set, prefixed if necessary
		let toset = decomp(name, val);

		try {
			// Put each decomposed key/val pair
			_.forEach(toset, ([k, v]) => txn.putBinary(dbt, k, v));

			if (closetxn) {
				txn.commit();
			}
		}
		catch (e) {
			if (closetxn) {
				txn.abort();
				ret = false;
			}
			throw e;
		}

		return ret;

		function decomp (key, value, prefix, accumulator) {
			// No prefix means empty string, so we don't get keys starting with '.'
			let pre = prefix ? prefix + '.' : '';
			let acc = accumulator || [];

			// Recurse with new prefix if value is object
			if (_.isObjectLike(value) && !_.isArray(value)) {
				return _.reduce(value, (a, v, k) => decomp(k, v, pre + key, a), acc);
			}
			// Otherwise, stringify and push prefixed key to result array
			else {
				acc.push([pre + key, new Buffer(JSON.stringify(value))]);
				return acc;
			}
		}
	}
}

module.exports = DBReader;
