#!/usr/bin/env node
'use strict';

const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const lmdb = require('../node-lmdb');
const Filters = require('../lib/filters.js');

// Config
const appcfg = _.defaultsDeep(
	{},
	require('../cfg/user.json'),
	require('../cfg/config.json')
);

// LMDB
const dbpath = path.isAbsolute(appcfg.dbpath) ? appcfg.dbpath : path.resolve(__dirname, '..', appcfg.dbpath);
var dbe = new lmdb.Env();
dbe.open({
	path: dbpath,
	mapSize: 1 * 1024 * 1024 * 1024,	// 1 GiB
	maxDbs: 10,
	maxReaders: 8,
	noSync: true,
	// noMetaSync: true,
});
const dbs = {};
const names = ['status', 'users', 'screennames', 'tweets', 'userdates', 'otherdates', 'favids', 'favdates', 'urls', 'media'];
for (let name of names) {
	dbs[name] = dbe.openDbi({name, create: true});
}

// Get file list
const filenames = process.argv.slice(2);

// GO!
// itertick(filenames, loadfile).then(() => console.log('Finished'));
for (let fname of filenames) {
	loadfile(fname);
}
console.log('Finished!');


// Funcs
function loadfile (name) {
	let filename = path.resolve(name);

	try {
		// Read file into memory
		let str = fs.readFileSync(filename, {encoding: 'utf8'});

		// Convert to JSON
		let eventlist = JSON.parse(str);

		// Feed each event to writer process
		for (let event of eventlist) {
			switch (event.type) {
				case 'user':
					writeuser(event.data);
					break;
				case 'user_tweet':
					writetweet(event.data);
					break;
				case 'other_tweet':
					writetweet(event.data);
					break;
				case 'delete':
					deletetweet(event.data);
					break;
				case 'favorite':
					writefav(event.data);
					break;
				case 'unfavorite':
					deletefav(event.data);
					break;
			}
		}

		console.log(`Processed ${filename}`);
	}
	catch (e) {
		console.error(`Error processing ${filename}:`);
		console.error(e);
	}
}

function tickstep (iter, last, func, res, rej) {
	if (last.done) {
		res(last.value);
	}
	else {
		try {
			// Call func for this iteration
			let newval = (func) ? func(last.value) : last.value;
			// Schedule next iterator step, passing in previous value (for generators)
			// TODO: check for thenable
			process.nextTick(tickstep, iter, iter.next(newval), func, res, rej);
		}
		catch (e) {
			// Reject original promise
			rej(e);
		}
	}
}

// TODO: Move to class to reuse elsewhere (along with tickstep() of course)
function itertick (iterable, iterfunc) {
	let iterator = iterable[Symbol.iterator]();

	return new Promise(function (resolve, reject) {
		// Start iterator and schedule stepper function
		process.nextTick(tickstep, iterator, iterator.next(), iterfunc, resolve, reject);
	});
}

function datestr (d) {
	let dt = d ? new Date(d) : new Date();
	return _.replace(dt.toISOString(), /[^0-9]/g, '');
}

function addindex (db, idx_str, val_str, txn) {
	let closetxn = false, ret = false;

	if (!txn) {
		// No transaction given, start a new one (possibly child)
		closetxn = true;
		txn = dbe.beginTxn();
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

function remindex (db, idx_str, val_str, txn) {
	let closetxn = false, ret = false;

	if (!txn) {
		// No transaction given, start a new one (possibly child)
		closetxn = true;
		txn = dbe.beginTxn();
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

function writetweet (tweet) {
	let txn = dbe.beginTxn();
	let ret = false;
	let idx = true;

	try {
		let dbt = dbs.tweets;
		let dbd = tweet.user.id_str == appcfg.user.id_str ? dbs.userdates : dbs.otherdates;
		let rstr = null;	// Rounded-off timestamp string
		let id_str = tweet.id_str;

		// Get date
		let dstr = _.has(tweet, 'timestamp_ms') ? datestr(parseInt(tweet.timestamp_ms)) : datestr(tweet.created_at);

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
				let s_dstr = _.has(stored, 'timestamp_ms') ? datestr(parseInt(stored.timestamp_ms)) : datestr(stored.created_at);

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
			addindex(dbd, dstr, id_str, txn);
		}

		// Check date index for old rounded time
		if (rstr !== null) {
			remindex(dbd, rstr, id_str, txn);
		}

		// Commit transaction
		txn.commit();
	}
	catch (e) {
		// Abort and log
		txn.abort();
		console.error(e);
	}

	return ret;
}

function deletetweet (del) {
	let txn = dbe.beginTxn();
	let ret = false;

	try {
		let dbt = dbs.tweets;
		let id_str = del.id_str;
		let dstr = null, duser_str;
		let deltweet = {
			id_str,
			user: {
				id_str: _.has(del,'user_id_str') ? del.user_id_str : _.has(del,'user.id_str') ? del.user.id_str : appcfg.user.id_str
			},
			deleted: del.time
		};

		let data = txn.getBinaryUnsafe(dbt, id_str);
		if (data !== null) {
			let stored = JSON.parse(data.toString());
			if (!stored.deleted) {
				dstr = _.has(stored, 'timestamp_ms') ? datestr(parseInt(stored.timestamp_ms)) : datestr(stored.created_at);
				duser_str = stored.user.id_str;
			}
		}

		// Write deleted-tweet object regardless
		txn.putBinary(dbt, id_str, Buffer.from(JSON.stringify(deltweet)));
		ret = true;

		// Remove index if now-deleted tweet was present
		if (dstr !== null) {
			let dbd = duser_str == appcfg.user.id_str ? dbs.userdates : dbs.otherdates;
			remindex(dbd, dstr, id_str, txn);
		}

		txn.commit();
	}
	catch (e) {
		// Abort and log
		txn.abort();
		console.error(e);
	}

	return ret;
}

function writeuser (userobj) {
	let txn = dbe.beginTxn();
	let ret = false;

	try {
		let dbu = dbs.users;
		let dbn = dbs.screennames;

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
			// TODO: move out of writeuser() when moving to write* funcs to own class
			// console.log(`[Updated user: @${userobj.user.screen_name}]`);
			ret = true;
		}

		// Write screen name to index
		// If a new user takes an already-stored screen name, it'll make a bucket
		// (We want this, because then searches will be properly informed of the ambiguity)
		addindex(dbn, userobj.user.screen_name, userobj.user.id_str, txn);

		// Commit transaction
		txn.commit();
	}
	catch (e) {
		// Abort and log
		txn.abort();
		console.error(e);
	}

	return ret;
}

function writefav (favorite) {
	let txn = dbe.beginTxn();
	let ret = false;

	try {
		let dbf = dbs.favids;
		let dbd = dbs.favdates;
		let id_str = favorite.id_str;
		let dstr = datestr(favorite.time);

		// Write favorite id_str
		let data = txn.getString(dbf, id_str);
		if (data === null) {
			txn.putString(dbf, id_str, _.toString(favorite.time));
			ret = true;
		}

		// Write favorite timestamp
		addindex(dbd, dstr, id_str, txn);

		// Commit transaction
		txn.commit();
	}
	catch (e) {
		// Abort and log
		txn.abort();
		console.error(e);
	}

	return ret;
}

function deletefav (unfavorite) {
	let txn = dbe.beginTxn();
	let ret = false;

	try {
		let dbf = dbs.favids;
		let dbd = dbs.favdates;
		let id_str = unfavorite.id_str;
		let dstr = null;

		// Write favorite id_str
		let data = txn.getString(dbf, id_str);
		if (data !== null) {
			dstr = datestr(parseInt(data));
			txn.del(dbf, id_str);
			ret = true;
		}

		// Delete favorite timestamp
		if (dstr !== null) {
			remindex(dbd, dstr, id_str, txn);
		}

		// Commit transaction
		txn.commit();
	}
	catch (e) {
		// Abort and log
		txn.abort();
		console.error(e);
	}

	return ret;
}

