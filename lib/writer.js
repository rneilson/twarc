'use strict';

const _ = require('lodash');
const path = require('path');
const ipc = require('node-ipc');
const Managed = require('./managed.js');
const DBWriter = require('./dbwrite.js');

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

// DB
const dbw = new DBWriter({
	user_id_str: appcfg.user.id_str,
	path: appcfg.dbpath,
	noSync: true
}, mgd.err.bind(mgd));
const dblog = true;

// Signal handlers
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {
	mgd.log('Caught signal, exiting...')
	.then(() => {
		// Close IPC server & open sockets
		ipc.server.stop();
		ipc.server.sockets.forEach(s => s.end());

		// Close DBs
		dbw.close();

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

// Start server
ipc.serve(() => {
	ipc.server.on('connect', socket => socket.on('end', () => socket.end()));
	ipc.server.on('queue', (data, socket) => writefn('queue', data));
	ipc.server.on('user', (data, socket) => writefn('user', data));
	ipc.server.on('user_tweet', (data, socket) => writefn('user_tweet', data));
	ipc.server.on('other_tweet', (data, socket) => writefn('other_tweet', data));
	ipc.server.on('delete', (data, socket) => writefn('delete', data));
	ipc.server.on('favorite', (data, socket) => writefn('favorite', data));
	ipc.server.on('unfavorite', (data, socket) => writefn('unfavorite', data));
	mgd.go();
	// mgd.sendmsg('ready');
});
ipc.server.start();


// Misc funcs
function logfn (type, data) {
	if (data) {
		if (_.isError(data)) {
			data = _.toString(data.stack);
		}
		return mgd.sendmsg({type, data}).catch(e => console.log(e));
	}
	return Promise.resolve();
}

function writefn (type, data, nosync, silent) {
	let sync = false;

	function writeq (queue) {
		const types = ['user', 'user_tweet', 'other_tweet', 'delete', 'favorite', 'unfavorite'];
		let syncq = false;
		let count;

		if (dblog) {
			mgd.log(`Received queue of ${data.length} items`);
			count = {
				'user': 0,
				'user_tweet': 0,
				'other_tweet': 0,
				'delete': 0,
				'favorite': 0,
				'unfavorite': 0
			};
		}

		// Recursively call
		for (let i = 0; i < queue.length; i++) {
			let item = queue[i];
			if (_.has(item, 'type') && _.has(item, 'data')) {
				// Leave sync to end of queue, but sync if any write succeeds
				if (writefn(item.type, item.data, true, true)) {
					syncq = true;
					if (dblog) {
						count[item.type]++;
					}
				}
			}
		}

		if (dblog && syncq) {
			let counts = [];
			for (let name of types) {
				let num = count[name];
				if (num > 0) {
					counts.push(`${num} ${name}${num > 1 ? 's' : ''}`);
				}
			}
			if (counts.length > 0) {
				mgd.log(`Wrote queue: ${counts.join(', ')}`);
			}
		}

		return syncq;
	}

	try {
		switch (type) {
			case 'queue':
				sync = writeq(data);
				break;
			case 'user':
				sync = dbw.writeuser(data);
				break;
			case 'user_tweet':
				sync = dbw.writetweet(data);
				break;
			case 'other_tweet':
				sync = dbw.writetweet(data);
				break;
			case 'delete':
				sync = dbw.deletetweet(data);
				break;
			case 'favorite':
				sync = dbw.writefav(data);
				break;
			case 'unfavorite':
				sync = dbw.deletefav(data);
				break;
		}
		if (dblog && !silent && sync && type !== 'queue') {
			mgd.log(`Wrote ${type}`);
		}
	}
	catch (e) {
		mgd.err(e);
	}

	if (sync && !nosync) {
		dbw.sync(err => {
			if (err) {
				mgd.err(err);
			}
		});
	}

	return sync;
}