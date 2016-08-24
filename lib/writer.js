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
	path: appcfg.dbpath
}, mgd.err.bind(mgd));

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
	ipc.server.on('user', dbw.writeuser.bind(dbw));
	ipc.server.on('user_tweet', dbw.writetweet.bind(dbw));
	ipc.server.on('other_tweet', dbw.writetweet.bind(dbw));
	ipc.server.on('delete', dbw.deletetweet.bind(dbw));
	ipc.server.on('favorite', dbw.writefav.bind(dbw));
	ipc.server.on('unfavorite', dbw.deletefav.bind(dbw));
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

