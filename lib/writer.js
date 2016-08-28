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
	const types = ['user', 'user_tweet', 'other_tweet', 'delete', 'favorite', 'unfavorite'];

	try {
		let ret = dbw.writeitem(type, data, !dblog);
		if (dblog) {
			let updstr;

			// Convert result to string description of updates
			if (ret) {
				if (_.isBoolean(ret)) {
					updstr = `Updated ${type}`;
				}
				else if (_.isArray(ret)) {
					// For now we can assume only status/status_raw return arrays
					updstr = 'Updated status items:\n    ' + ret.join('\n    ');
				}
				else if (_.isObject(ret)) {
					// For now we can assume only queue returns objects
					let total = 0;
					let counts = [];
					let stastr = '';
					if (ret.status.size > 0) {
						// Convert to array since we'll join it later anyways
						// TODO: don't
						let statuses = Array.from(ret.status);
						let num = statuses.length;
						total += num;
						// TODO: change to for..of so we don't double-iterate
						stastr = '\nUpdated status items:\n    ' + statuses.join('\n    ');
						counts.push(`${num} status item${num > 1 ? 's' : ''}`);
					}
					for (let name of types) {
						let num = ret[name];
						if (num > 0) {
							total += num;
							counts.push(`${num} ${name}${num == 1 ? '' : name.endsWith('s') ? 'es' : 's'}`);
						}
					}
					updstr = `Updated ${total} items (${counts.join(', ')})` + stastr;
				}
				// Any other cases we want to handle?
			}
			else if (type === 'queue') {
				updstr = 'All items up-to-date';
			}

			if (updstr) {
				mgd.log(updstr);
			}
		}
	}
	catch (e) {
		mgd.err(e);
	}
}

