'use strict';

const _ = require('lodash');
const path = require('path');
const lmdb = require('../node-lmdb');
const Filters = require('./filters.js');
const DBReader = require('./dbread.js');

// Config
const defaultopts = DBReader.defaultoptions();
const dbnames = DBReader.dbnamelist();

class DBWriter extends DBReader {

	constructor (options) {
		super(options);

		// Check for user id in DB, write if not present
		if (this.getstatus('user.id_str') === null) {
			this.setstatus('user.id_str', this.user_id_str);
		}
	}

	sync (callback) {
		this.env.sync(callback);
	}

	begin (readonly) {
		return this.env.beginTxn(readonly ? {readOnly: true} : undefined);
	}

	setstatus (name, val, time, txn) {
		let dbt = this.dbs.status;
		let ret = [];
		let closetxn = false;

		if (!txn) {
			// No transaction given, start a new one
			txn = this.env.beginTxn();
			closetxn = true;
		}

		try {
			// 'toset' is array of key/value pairs to set, prefixed as necessary
			// Decompose object if req'd (array value w/o prefix is assumed to already be k/v pairs)
			let toset = (name === '' && _.isArray(val)) ? toset : decomp(name, val);

			// Explicit false means val contains raw time/data pairs
			if (time !== false) {
				// Use given time (or now) for all keys
				time = time || Date.now();
			}

			// Put each decomposed key/val pair and log key
			_.forEach(toset, ([k, v]) => {
				// Time will be falsy only if explicit false was passed to setstatus()
				// Which means to presume given value is time/data pair
				let vt = time || v[0];

				let s = txn.getBinaryUnsafe(dbt, k);
				let put = false;
				if (s === null) {
					put = true;
				}
				else {
					// Extract time from stored value for comparison
					let [t, d] = JSON.parse(s.toString());
					// Only store if newer
					if (vt > t) {
						put = true;
					}
				}

				if (put) {
					// Put either given value as time/data pair (if time false)
					// or make given time and given value into pair
					txn.putBinary(dbt, k, new Buffer(JSON.stringify(time ? [vt, v] : v)));
					ret.push(k);
				}
			});

			if (closetxn) {
				txn.commit();
			}
		}
		catch (e) {
			if (closetxn) {
				txn.abort();
				// ret = false;
			}
			throw e;
		}

		if (ret.length === 0) {
			return false;
		}
		return ret;

		function decomp (key, value, prefix, accumulator) {
			// No prefix means empty string, so we don't get keys starting with '.'
			let pre = prefix ? prefix + '.' : '';
			let acc = accumulator || [];

			// Recurse with new prefix if value is object
			if (_.isObjectLike(value) && !_.isArray(value)) {
				// return _.reduce(value, (a, v, k) => decomp(k, v, pre + key, a), acc);
				_.forOwn(value, (v, k) => decomp(k, v, pre + key, acc));
			}
			// Otherwise, stringify and push prefixed key to result array
			else {
				acc.push([pre + key, value]);
			}
			return acc;
		}
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
				ret = false;
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
				ret = false;
			}
			else {
				throw e;
			}
		}

		return ret;
	}

	writeitem (type, data, txn) {
		let ret = false;
		let time;

		switch (type) {
			case 'queue':
				ret = this.writequeue(data, txn);
				break;
			case 'status_raw':
				ret = this.setstatus('', data, false, txn);
				break;
			case 'status':
				time = data.time;
				delete data.time;
				ret = this.setstatus('', data, time, txn);
				break;
			case 'user':
				ret = this.writeuser(data, txn);
				break;
			case 'user_tweet':
				ret = this.writetweet(data, txn);
				break;
			case 'other_tweet':
				ret = this.writetweet(data, txn);
				break;
			case 'delete':
				ret = this.deletetweet(data, txn);
				break;
			case 'favorite':
				ret = this.writefav(data, txn);
				break;
			case 'unfavorite':
				ret = this.deletefav(data, txn);
				break;
		}

		return ret;
	}

	writequeue (queue, txn) {
		let ret = false;
		let closetxn = false;
		let count = {
			'status': new Set(),
			'user': 0,
			'user_tweet': 0,
			'other_tweet': 0,
			'delete': 0,
			'favorite': 0,
			'unfavorite': 0
		};

		// Open transaction if req'd
		if (!txn) {
			txn = this.env.beginTxn();
			closetxn = true;
		}

		try {
			// Recursively call
			for (let i = 0; i < queue.length; i++) {
				let item = queue[i];
				if (_.has(item, 'type') && _.has(item, 'data')) {
					// Leave return value to end of queue, but return something if any write succeeds
					let retw = this.writeitem(item.type, item.data, txn);
					if (retw) {
						if (_.isArray(retw)) {
							_.forEach(retw, k => count.status.add(k));
						}
						else if (_.isObject(retw)) {
							// Assume returned object is from a sub-queue
							// Merge counts
							for (let st of retw.status) {
								count.status.add(st);
							}
							for (let t of types) {
								count[t] += retw[t];
							}
						}
						else {
							count[item.type]++;
						}
						ret = count;
					}
				}
			}

			if (closetxn) {
				txn.commit();
			}
		}
		catch (e) {
			if (closetxn) {
				txn.abort();
			}
			throw e;
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
				txn.abort();
			}
			throw e;
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
				txn.abort();
			}
			throw e;
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

				// Check if it's user's id, and write screen name to config if not present
				if (userobj.user.id_str == this.user_id_str &&
					userobj.user.screen_name != this.getstatus('user.screen_name', false, txn)) {
					this.setstatus('user.screen_name', userobj.user.screen_name, userobj.time, txn);
				}
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
				txn.abort();
			}
			throw e;
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
			let ostr = null;	// Old timestamp

			// Write favorite id_str
			let data = txn.getString(dbf, id_str);
			let put = false;
			if (data === null) {
				put = true;
			}
			else {
				// Check if current time is later than stored
				// (Would imply fav has been unfav'd at some point)
				let stime = parseInt(data);
				if (favorite.time > stime) {
					put = true;
					ostr = datestr(stime);
				}
			}

			if (put) {
				txn.putString(dbf, id_str, _.toString(favorite.time));
				ret = true;
			}

			// Write favorite timestamp
			this.addindex(dbd, dstr, id_str, txn);

			// Remove old index
			if (ostr !== null) {
				this.remindex(dbd, ostr, id_str, txn);
			}

			// Commit transaction
			if (closetxn) {
				txn.commit();
			}
		}
		catch (e) {
			if (closetxn) {
				txn.abort();
			}
			throw e;
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
				txn.abort();
			}
			throw e;
		}

		return ret;
	}

}

module.exports = DBWriter;
