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
	// noSync: true
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
	ipc.server.on('queue', (data, socket) => writer('queue', data));
	ipc.server.on('status', (data, socket) => writer('status', data));
	ipc.server.on('following', (data, socket) => writer('following', data));
	ipc.server.on('user', (data, socket) => writer('user', data));
	ipc.server.on('user_tweet', (data, socket) => writer('user_tweet', data));
	ipc.server.on('other_tweet', (data, socket) => writer('other_tweet', data));
	ipc.server.on('delete', (data, socket) => writer('delete', data));
	ipc.server.on('favorite', (data, socket) => writer('favorite', data));
	ipc.server.on('unfavorite', (data, socket) => writer('unfavorite', data));
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

function writer (type, data) {
	try {
		let ret = writefn(type, data, undefined, !dblog);
		if (dblog) {
			mgd.log(ret);
		}
	}
	catch (e) {
		mgd.err(e);
	}
}

function writefn (type, data, txn, silent) {
	let ret = false;
	let time;

	switch (type) {
		case 'queue':
			ret = writeq(data, silent);
			break;
		case 'status_raw':
			ret = dbw.setstatus('', data, false, txn);
			break;
		case 'status':
			time = data.time;
			delete data.time;
			ret = dbw.setstatus('', data, time, txn);
			break;
		case 'user':
			ret = dbw.writeuser(data, txn);
			break;
		case 'user_tweet':
			ret = dbw.writetweet(data, txn);
			break;
		case 'other_tweet':
			ret = dbw.writetweet(data, txn);
			break;
		case 'delete':
			ret = dbw.deletetweet(data, txn);
			break;
		case 'favorite':
			ret = dbw.writefav(data, txn);
			break;
		case 'unfavorite':
			ret = dbw.deletefav(data, txn);
			break;
	}

	if (!silent && ret) {
		if (_.isBoolean(ret)) {
			ret = `Updated ${type}`;
		}
		else if (_.isArray(ret)) {
			// For now we can assume only status/following return arrays (for now)
			ret = 'Updated status items:\n    ' + ret.join('\n    ');
		}
		// Any other cases we want to handle?
	}

	return ret;

	function writeq (queue, quiet) {
		const types = ['user', 'user_tweet', 'other_tweet', 'delete', 'favorite', 'unfavorite'];
		let retq = false;
		let count;
		let total = 0;

		count = {
			'status': new Set(),
			'user': 0,
			'user_tweet': 0,
			'other_tweet': 0,
			'delete': 0,
			'favorite': 0,
			'unfavorite': 0
		};

		// Open transaction
		let qtxn = dbw.begin();

		try {
			// Recursively call
			for (let i = 0; i < queue.length; i++) {
				let item = queue[i];
				if (_.has(item, 'type') && _.has(item, 'data')) {
					// Leave return value to end of queue, but return something if any write succeeds
					let retw = writefn(item.type, item.data, qtxn, true);
					if (retw) {
						retq = true;
						if (_.isArray(retw)) {
							_.forEach(retw, k => count.status.add(k));
						}
						else {
							count[item.type]++;
						}
					}
				}
			}

			qtxn.commit();

			if (!quiet) {
				if (retq) {
					let counts = [];
					retq = '';
					if (count.status.size > 0) {
						let statuses = Array.from(count.status);
						let num = statuses.length;
						total += num;
						retq += 'Updated status items:\n    ' + statuses.join('\n    ') + '\n';
						counts.push(`${num} status item${num > 1 ? 's' : ''}`);
					}
					for (let name of types) {
						let num = count[name];
						if (num > 0) {
							total += num;
							counts.push(`${num} ${name}${num == 1 ? '' : name.endsWith('s') ? 'es' : 's'}`);
						}
					}
					retq += `Updated ${total} items (${counts.join(', ')})`;
				}
				else {
					retq = `All items up-to-date`;
				}
			}
		}
		catch (e) {
			qtxn.abort();
			throw e;
		}

		return retq;
	}
}
