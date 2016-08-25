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

}

module.exports = DBReader;
