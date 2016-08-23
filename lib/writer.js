'use strict';

const _ = require('lodash');
const path = require('path');
const ipc = require('node-ipc');
const lmdb = require('../node-lmdb');
const Filters = require('./filters.js');
const Managed = require('./managed.js');

// Config
const appcfg = _.defaultsDeep(
	{},
	require('../cfg/user.json'),
	require('../cfg/config.json')
);

// IPC setup
const mgd = new Managed(
	{waitforgo: true},
	logfn.bind(null, 'log'),
	logfn.bind(null, 'err')
);
_.assign(ipc.config, {
	appspace: 'twarc',
	socketRoot: path.resolve(appcfg.sockpath) + path.sep,
	id: process.env.childname,
	retry: 250,
	silent: true
});

// LMDB
var dbe = new lmdb.Env();
dbe.open({
	path: path.resolve(appcfg.dbpath),
	mapSize: 1 * 1024 * 1024 * 1024,	// 1 GiB
	maxDbs: 8
});
const dbs = {};
const names = ['users', 'screennames', 'tweets', 'userdates', 'otherdates', 'favids', 'favdates'];
for (let name of names) {
	dbs[name] = dbe.openDbi({name, create: true});
}

// Signal handlers
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {
	mgd.log('Caught signal, exiting...')
	.then(() => {
		// Close twitter IPC socket
		if (ipc.of.twitter) {
			ipc.of.twitter.config.stopRetrying = true;
			if (ipc.of.twitter.socket) {
				ipc.of.twitter.socket.end();
			}
		}

		// Close DBs
		for (let key of Object.keys(dbs)) {
			dbs[key].close();
		}
		dbe.close();

		return 0;
	}).catch(e => {
		// First catch in case of close errors
		return mgd.err(e);
	}).catch(e => {
		// Second catch in case of log error
		console.error(e);
		return 1;
	}).then(code => {
		process.exitCode = code;
		process.disconnect();
	});
});

// Listen on twitter's socket
// Add delay to give twitter proc some time
setTimeout(() => {
	ipc.connectTo(
		'twitter',
		() => {
			ipc.of.twitter.on('user', writeuser);
			ipc.of.twitter.on('user_tweet', writetweet);
			ipc.of.twitter.on('other_tweet', writetweet);
			ipc.of.twitter.on('delete', deletetweet);
			ipc.of.twitter.on('favorite', writefav);
			ipc.of.twitter.on('unfavorite', deletefav);
			// ipc.of.twitter.on('log', writefn.bind(null, 'log'));

			// ipc.of.twitter.on('terminate', () => ipc.disconnect('twitter'));
			ipc.of.twitter.on('connect', () => {
				ipc.of.twitter.socket.on('end', () => ipc.of.twitter.socket.end());
				mgd.go();
				// This will (should) send ready to master once socket reconnects
				// So no need to directly handle 'pause' event
				mgd.sendmsg('ready');
				mgd.log('Connected to Twitter socket');
			});
		}
	);
}, 250);

// Misc funcs
function datestr (d) {
	let dt = d ? new Date(d) : new Date();
	return _.replace(dt.toISOString(), /[^0-9]/g, '');
}

function logfn (type, data) {
	if (data) {
		if (_.isError(data)) {
			data = _.toString(data.stack);
		}
		return mgd.sendmsg({type, data}).catch(e => console.log(e));
	}
	return Promise.resolve();
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
		mgd.err(e);
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
		mgd.err(e);
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
			mgd.log(`[Updated user: @${userobj.user.screen_name}]`);
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
		mgd.err(e);
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
		mgd.err(e);
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
		mgd.err(e);
	}

	return ret;
}

