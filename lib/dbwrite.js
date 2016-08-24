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

class DBWriter {

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

	close () {
		for (let name of dbnames) {
			this.dbs[name].close();
		}
		this.env.close();
	}

	sync (callback) {
		this.env.sync(callback);
	}

	datestr (d) {
		let dt = d ? new Date(d) : new Date();
		return _.replace(dt.toISOString(), /[^0-9]/g, '');
	}

	addindex (db, idx_str, val_str, txn) {
		let closetxn = false, ret = false;

		if (!txn) {
			// No transaction given, start a new one (possibly child)
			closetxn = true;
			txn = this.env.beginTxn();
		}

		try {
			let data = txn.getString(db, idx_str);
			if (data === null) {
				txn.putString(db, idx_str, val_str);
				ret = true;
			}
			else {
				// Check for bucket
				if (data.startsWith('[')) {
					let bucket = JSON.parse(data);
					if (!_.includes(bucket, val_str)) {
						// Add to bucket and write updated bucket
						bucket.push(val_str);
						txn.putString(db, idx_str, JSON.stringify(bucket));
						ret = true;
					}
				}
				else if (data != val_str) {
					// Create bucket of other val_str and this one
					let bucket = [data, val_str];
					txn.putString(db, idx_str, JSON.stringify(bucket));
					ret = true;
				}
			}

			if (closetxn) {
				txn.commit();
			}
		}
		catch (e) {
			if (closetxn) {
				// Since we have our own transaction, we don't have to re-throw
				txn.abort();
			}
			else {
				throw e;
			}
		}

		return ret;
	}

	remindex (db, idx_str, val_str, txn) {
		let closetxn = false, ret = false;

		if (!txn) {
			// No transaction given, start a new one (possibly child)
			closetxn = true;
			txn = this.env.beginTxn();
		}

		try {
			let data = txn.getString(db, idx_str);
			// Delete old index if present
			if (data !== null) {
				if (data.startsWith('[')) {
					let bucket = JSON.parse(data);
					let idx = _.indexOf(bucket, val_str);
					if (idx >= 0) {
						// Remove index from bucket
						bucket.splice(idx, 1);
						// Store modified bucket (or sole remaining index)
						txn.putString(db, idx_str, bucket.length > 1 ? JSON.stringify(bucket) : bucket[0]);
						ret = true;
					}
				}
				else if (data == val_str) {
					// Delete now-obsolete index
					txn.del(db, idx_str);
					ret = true;
				}
			}

			if (closetxn) {
				txn.commit();
			}
		}
		catch (e) {
			if (closetxn) {
				// Since we have our own transaction, we don't have to re-throw
				txn.abort();
			}
			else {
				throw e;
			}
		}

		return ret;
	}

	writetweet (tweet, txn) {
		let closetxn = false;
		let ret = false;
		let idx = true;

		if (!txn) {
			// No transaction given, start a new one (possibly child)
			closetxn = true;
			txn = this.env.beginTxn();
		}

		try {
			let dbt = this.dbs.tweets;
			let dbd = tweet.user.id_str == this.user_id_str ? this.dbs.userdates : this.dbs.otherdates;
			let rstr = null;	// Rounded-off timestamp string
			let id_str = tweet.id_str;

			// Get date
			let dstr = _.has(tweet, 'timestamp_ms') ? this.datestr(parseInt(tweet.timestamp_ms)) : this.datestr(tweet.created_at);

			// Write tweet itself
			let data = txn.getBinaryUnsafe(dbt, id_str);
			let put = false;
			if (data === null) {
				put = true;
			}
			else {
				let stored = JSON.parse(data.toString());
				if (stored.deleted) {
					// Don't write, don't index
					idx = false;
				}
				else {
					// Compare stored and given tweets for rounded timestamps
					let s_dstr = _.has(stored, 'timestamp_ms') ? this.datestr(parseInt(stored.timestamp_ms)) : this.datestr(stored.created_at);

					// Given tweet has rounded timestamp
					if (_.endsWith(dstr, '000')) {
						// Check if stored tweet has precise timestamp, use that instead if so
						if (!_.endsWith(s_dstr, '000')) {
							rstr = dstr;	// Will remove old rounded timestamp from index
							dstr = s_dstr;	// Will check index at precise timestamp (unlikely to set if tweet already present)
						}
					}
					// Given tweet has precise timestamp
					else {
						// Check if stored tweet has rounded timestamp, replace it if so
						if (_.endsWith(s_dstr, '000')) {
							rstr = s_dstr;	// Will remove old rounded timestamp from index
							// Store new precise-time tweet version
							put = true;
						}
					}
				}
			}
			if (put) {
				txn.putBinary(dbt, id_str, Buffer.from(JSON.stringify(tweet)));
				ret = true;
			}

			// Write ref to tweet in appropriate date index (if tweet not deleted)
			// Don't set ret as true if writing, since we didn't necessarily write the index
			if (idx) {
				this.addindex(dbd, dstr, id_str, txn);
			}

			// Check date index for old rounded time
			if (rstr !== null) {
				this.remindex(dbd, rstr, id_str, txn);
			}

			// Commit transaction
			if (closetxn) {
				txn.commit();
			}
		}
		catch (e) {
			if (closetxn) {
				// Abort and log
				// Since we have our own transaction, we don't have to re-throw
				txn.abort();
				this.err(e);
			}
			else {
				throw e;
			}
		}

		return ret;
	}

	deletetweet (del, txn) {
		let closetxn = false;
		let ret = false;

		if (!txn) {
			// No transaction given, start a new one (possibly child)
			closetxn = true;
			txn = this.env.beginTxn();
		}

		try {
			let dbt = this.dbs.tweets;
			let id_str = del.id_str;
			let dstr = null, duser_str;
			let deltweet = {
				id_str,
				user: {
					id_str: _.has(del,'user_id_str') ? del.user_id_str : _.has(del,'user.id_str') ? del.user.id_str : this.user_id_str
				},
				deleted: del.time
			};

			let data = txn.getBinaryUnsafe(dbt, id_str);
			let put = false;
			if (data === null) {
				put = true;
			}
			else {
				let stored = JSON.parse(data.toString());
				if (!stored.deleted) {
					dstr = _.has(stored, 'timestamp_ms') ? this.datestr(parseInt(stored.timestamp_ms)) : this.datestr(stored.created_at);
					duser_str = stored.user.id_str;
					put = true;
				}
			}

			// Write deleted-tweet object
			if (put) {
				txn.putBinary(dbt, id_str, Buffer.from(JSON.stringify(deltweet)));
				ret = true;
			}

			// Remove index if now-deleted tweet was present
			if (dstr !== null) {
				let dbd = duser_str == this.user_id_str ? this.dbs.userdates : this.dbs.otherdates;
				this.remindex(dbd, dstr, id_str, txn);
			}

			// Commit transaction
			if (closetxn) {
				txn.commit();
			}
		}
		catch (e) {
			if (closetxn) {
				// Abort and log
				// Since we have our own transaction, we don't have to re-throw
				txn.abort();
				this.err(e);
			}
			else {
				throw e;
			}
		}

		return ret;
	}

	writeuser (userobj, txn) {
		let closetxn = false;
		let ret = false;

		if (!txn) {
			// No transaction given, start a new one (possibly child)
			closetxn = true;
			txn = this.env.beginTxn();
		}

		try {
			let dbu = this.dbs.users;
			let dbn = this.dbs.screennames;

			// Write user data
			let data = txn.getBinaryUnsafe(dbu, userobj.user.id_str)
			let put = false;
			if (data === null) {
				put = true;
			}
			else {
				// Read current user object
				let currobj = JSON.parse(data.toString());
				let currdt = new Date(currobj.time);
				let userdt = new Date(userobj.time);

				// Compare to old, only write if newer and different
				if (userdt > currdt && !Filters.equaluser(userobj.user, currobj.user)) {
					put = true;
				}
			}
			if (put) {
				txn.putBinary(dbu, userobj.user.id_str, Buffer.from(JSON.stringify(userobj)));
				ret = true;
			}

			// Write screen name to index
			// If a new user takes an already-stored screen name, it'll make a bucket
			// (We want this, because then searches will be properly informed of the ambiguity)
			this.addindex(dbn, userobj.user.screen_name, userobj.user.id_str, txn);

			// Commit transaction
			if (closetxn) {
				txn.commit();
			}
		}
		catch (e) {
			if (closetxn) {
				// Abort and log
				// Since we have our own transaction, we don't have to re-throw
				txn.abort();
				this.err(e);
			}
			else {
				throw e;
			}
		}

		return ret;
	}

	writefav (favorite, txn) {
		let closetxn = false;
		let ret = false;

		if (!txn) {
			// No transaction given, start a new one (possibly child)
			closetxn = true;
			txn = this.env.beginTxn();
		}

		try {
			let dbf = this.dbs.favids;
			let dbd = this.dbs.favdates;
			let id_str = favorite.id_str;
			let dstr = this.datestr(favorite.time);

			// Write favorite id_str
			let data = txn.getString(dbf, id_str);
			if (data === null) {
				txn.putString(dbf, id_str, _.toString(favorite.time));
				ret = true;
			}

			// Write favorite timestamp
			this.addindex(dbd, dstr, id_str, txn);

			// Commit transaction
			if (closetxn) {
				txn.commit();
			}
		}
		catch (e) {
			if (closetxn) {
				// Abort and log
				// Since we have our own transaction, we don't have to re-throw
				txn.abort();
				this.err(e);
			}
			else {
				throw e;
			}
		}

		return ret;
	}

	deletefav (unfavorite, txn) {
		let closetxn = false;
		let ret = false;

		if (!txn) {
			// No transaction given, start a new one (possibly child)
			closetxn = true;
			txn = this.env.beginTxn();
		}

		try {
			let dbf = this.dbs.favids;
			let dbd = this.dbs.favdates;
			let id_str = unfavorite.id_str;
			let dstr = null;

			// Write favorite id_str
			let data = txn.getString(dbf, id_str);
			if (data !== null) {
				dstr = this.datestr(parseInt(data));
				txn.del(dbf, id_str);
				ret = true;
			}

			// Delete favorite timestamp
			if (dstr !== null) {
				this.remindex(dbd, dstr, id_str, txn);
			}

			// Commit transaction
			if (closetxn) {
				txn.commit();
			}
		}
		catch (e) {
			if (closetxn) {
				// Abort and log
				// Since we have our own transaction, we don't have to re-throw
				txn.abort();
				this.err(e);
			}
			else {
				throw e;
			}
		}

		return ret;
	}

}

module.exports = DBWriter;
