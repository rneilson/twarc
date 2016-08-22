'use strict';

const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const ipc = require('node-ipc');
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

// Output file
var nowstr = _.replace(new Date().toISOString(), /[^0-9]/g, '').substr(0, 14);
var outfile = fs.openSync(`./tmp/stream-${nowstr}.json`, 'w');
fs.appendFileSync(outfile, '[\n');

// Signal handlers
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {
	// ipc.disconnect('twitter');
	if (ipc.of.twitter) {
		ipc.of.twitter.config.stopRetrying = true;
		if (ipc.of.twitter.socket) {
			ipc.of.twitter.socket.end();
		}
	}

	mgd.log('Caught signal, exiting...')
	.then(() => {
		// Close off file
		return new Promise((resolve, reject) => {
			fs.appendFile(outfile, ']\n', err => {
				if (err) {
					reject(err);
				}
				else {
					resolve();
				}
			});
		});
	}).then(() => {
		fs.closeSync(outfile);
		return 0;
	}).catch(e => {
		// First catch in case file append/close errors
		if (_.isError(e)) {
			e = _.toString(e.stack);
		}
		return mgd.err(e);
	}).catch(e => {
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
			// ipc.of.twitter.on('terminate', () => ipc.disconnect('twitter'));
			ipc.of.twitter.on('log', writefn.bind(null, 'log'));
			ipc.of.twitter.on('user', writefn.bind(null, 'user'));
			ipc.of.twitter.on('user_tweet', writefn.bind(null, 'user_tweet'));
			ipc.of.twitter.on('other_tweet', writefn.bind(null, 'other_tweet'));
			ipc.of.twitter.on('favorite', writefn.bind(null, 'favorite'));
			ipc.of.twitter.on('delete', writefn.bind(null, 'delete'));
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
function logfn (type, data) {
	if (data) {
		if (_.isError(data)) {
			data = _.toString(data.stack);
		}
		return mgd.sendmsg({type, data}).catch(e => console.log(e));
	}
	return Promise.resolve();
}

function writefn (type, data) {

	function err (e) {
		mgd.err(e);
	}

	fs.appendFile(outfile, JSON.stringify({type, data}, null, 2) + ',\n', err);
}

