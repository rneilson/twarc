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
	socketRoot: path.join(process.cwd(), appcfg.sockpath),
	id: process.env.childname,
	retry: 250,
	silent: true
});

// LMDB
var dbe = new lmdb.Env();
dbe.open({
	path: path.resolve(process.cwd(), appcfg.dbpath),
	mapSize: 1 * 1024 * 1024 * 1024,	// 1 GiB
	maxDbs: 8
});
const dbs = {
	users: dbe.openDbi({name: "users", create: true}),
	screennames: dbe.openDbi({name: "screennames", create: true}),
	tweets: dbe.openDbi({name: "tweets", create: true}),
	userdates: dbe.openDbi({name: "userdates", create: true}),
	otherdates: dbe.openDbi({name: "otherdates", create: true}),
	favdates: dbe.openDbi({name: "favdates", create: true}),
};

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
			ipc.of.twitter.on('user_tweet', writetweet.bind(null, 'user_tweet'));
			ipc.of.twitter.on('other_tweet', writetweet.bind(null, 'other_tweet'));
			ipc.of.twitter.on('favorite', writefav);
			// ipc.of.twitter.on('log', writefn.bind(null, 'log'));
			// ipc.of.twitter.on('delete', writefn.bind(null, 'delete'));

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

function writetweet (type, tweet) {
	let txn = dbe.beginTxn();
	let ret = false;

	try {
		let dbt = dbs.tweets;
		let dbd = type === 'user_tweet' ? dbs.userdates : dbs.otherdates;
		let rstr = null;	// Rounded-off timestamp string
		let id_str = tweet.id_str;

		// Get date
		let dstr = _.has(tweet, 'timestamp_ms') ? datestr(parseInt(tweet.timestamp_ms)) : datestr(tweet.created_at);

		// Write tweet itself
		let data = txn.getBinaryUnsafe(dbt, id_str);
		if (data === null) {
			txn.putBinary(dbt, id_str, Buffer.from(JSON.stringify(tweet)));
			ret = true;
		}
		else {
			// Compare stored and given tweets for rounded timestamps
			let stored = JSON.parse(data.toString());
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
					txn.putBinary(dbt, id_str, Buffer.from(JSON.stringify(tweet)));
					ret = true;
				}
			}
		}

		// Write ref to tweet in appropriate date index
		// Don't set ret as true if writing, since we didn't necessarily write the index
		data = txn.getString(dbd, dstr);
		if (data === null) {
			txn.putString(dbd, dstr, id_str);
		}
		else {
			if (data.startsWith('[')) {
				let bucket = JSON.parse(data);
				if (!_.includes(bucket, id_str)) {
					// Add to bucket and write updated bucket
					bucket.push(id_str);
					txn.putString(dbd, dstr, JSON.stringify(bucket));
				}
			}
			else if (data != id_str) {
				// Create bucket of other id_str and this one
				let bucket = [data, id_str];
				txn.putString(dbd, dstr, JSON.stringify(bucket));
			}
		}

		// Check date index for old rounded time
		if (rstr !== null) {
			data = txn.getString(dbd, rstr);
			// Delete old rounded time if indexed
			if (data !== null) {
				if (data.startsWith('[')) {
					let bucket = JSON.parse(data);
					let idx = _.indexOf(bucket, id_str);
					if (idx >= 0) {
						// Remove index from bucket
						bucket.splice(idx, 1);
						// Store modified bucket (or sole remaining index)
						txn.putString(dbd, rstr, bucket.length > 1 ? JSON.stringify(bucket) : bucket[0]);
					}
				}
				else if (data == id_str) {
					// Delete now-obsolete index
					txn.del(dbd, rstr);
				}
			}
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

function writeuser (userobj) {
	let txn = dbe.beginTxn();
	let ret = false;

	try {
		let dbu = dbs.users;
		let dbn = dbs.screennames;

		// Write user data
		let data = txn.getBinaryUnsafe(dbu, userobj.user.id_str)
		if (data === null) {
			txn.putBinary(dbu, userobj.user.id_str, Buffer.from(JSON.stringify(userobj)));
			// TODO: move out of writeuser() when moving to write* funcs to own class
			mgd.log(`[Updated user: @${userobj.user.screen_name}]`);
			ret = true;
		}
		else {
			// Read current user object
			let currobj = JSON.parse(data.toString());
			let currdt = new Date(currobj.time);
			let userdt = new Date(userobj.time);

			// Compare to old, only write if newer and different
			if (userdt > currdt && !Filters.equaluser(userobj.user, currobj.user)) {
				txn.putBinary(dbu, userobj.user.id_str, Buffer.from(JSON.stringify(userobj)));
				// TODO: move out of writeuser() when moving to write* funcs to own class
				mgd.log(`[Updated user: @${userobj.user.screen_name}]`);
				ret = true;
			}
		}

		// Write screen name to index
		data = txn.getString(dbn, userobj.user.screen_name);
		if (data === null) {
			txn.putString(dbn, userobj.user.screen_name, userobj.user.id_str);
			// Don't set ret as true, since we didn't necessarily write the user object
		}
		// TODO: check for screen name pointing to wrong user?

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
		let dbf = dbs.favdates;
		let dstr = datestr(favorite.time);

		// Write favorite data if given
		let data = txn.getBinaryUnsafe(dbf, dstr);
		if (data === null) {
			txn.putBinary(dbf, dstr, Buffer.from(JSON.stringify(favorite)));
			ret = true;
		}
		// TODO: check for bucket

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

