'use strict';

const _ = require('lodash');
const path = require('path');
const ipc = require('node-ipc');
const lmdb = require('../node-lmdb');
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
var dbs = {
	users: dbe.openDbi({name: "users", create: true}),
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

	try {
		let dbt = dbs.tweets;
		let dbd = type === 'user_tweet' ? dbs.userdates : dbs.otherdates;

		// Write tweet itself
		let data = txn.getBinary(dbt, tweet.id_str);
		if (data === null) {
			txn.putBinary(dbt, tweet.id_str, Buffer.from(JSON.stringify(tweet)));
		}
		// TODO: compare stored tweet for rounded-off timestamp?

		// Get date
		let dstr;
		if (_.has(tweet, 'timestamp_ms')) {
			dstr = datestr(parseInt(tweet.timestamp_ms));
		}
		else {
			dstr = datestr(tweet.created_at);
		}

		// Write ref to tweet in appropriate date index
		data = txn.getString(dbd, dstr);
		if (data === null) {
			txn.putString(dbd, dstr, tweet.id_str);
		}

		// TODO: check for bucket - might have to if only accurate to second...or
		// should we make per-second buckets in general?

		// TODO: might get slightly different times for fav'd vs RT'd; prevent
		// double-indexing by checking for rounded-off time?

		// Commit transaction
		txn.commit();

		return true;
	}
	catch (e) {
		// Abort and log
		txn.abort();
		mgd.err(e);

		return false;
	}
}

function writeuser (userobj) {
	let txn = dbe.beginTxn();

	try {
		let dbu = dbs.users;

		// Write user data if given
		// TODO: compare to old, or assume twitter process knows best?
		txn.putBinary(dbu, userobj.user.id_str, Buffer.from(JSON.stringify(userobj)));

		// Commit transaction
		txn.commit();

		return true;
	}
	catch (e) {
		// Abort and log
		txn.abort();
		mgd.err(e);

		return false;
	}
}

function writefav (favorite) {
	let txn = dbe.beginTxn();

	try {
		let dbf = dbs.favdates;
		let dstr = datestr(favorite.time);

		// Write favorite data if given
		let data = txn.getBinary(dbf, dstr);
		if (data === null) {
			txn.putBinary(dbf, dstr, Buffer.from(JSON.stringify(favorite)));
		}

		// TODO: check for fav time rounded to second to avoid duplicates?

		// Commit transaction
		txn.commit();

		return true;
	}
	catch (e) {
		// Abort and log
		txn.abort();
		mgd.err(e);

		return false;
	}
}

