#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const _ = require('lodash');
const Manager = require('./manager.js');

// Modules used by children
// const ipc = require('node-ipc');
// const lmdb = require('node-lmdb');
// const Twitter = require('twitter');

// Change to base directory for consistency
process.chdir(path.join(__dirname, '..'));

// API keys
// const apikeys = Object.assign({}, require('./cfg/consumer.json'), require('./cfg/access.json'));

// Config
// const appcfg = Object.assign({}, require('./cfg/config.json'), apikeys);
const appcfg = _.defaultsDeep(
	{},
	require('../cfg/user.json'),
	require('../cfg/config.json')
);

// Open log file
// TODO: rotate logs on startup
const logfile = fs.openSync(path.join(appcfg.logpath, 'master.log'), 'a');

// Children to launch
// const childnames = ['writer', 'twitter', 'archiver', 'websrv'];
const childnames = ['twitter', 'writer'];


function errcb (err) {
	if (err) {
		if (_.isError(err)) {
			err = _.toString(err.stack);
		}
		console.error('[ERROR]', err);
	}
}

function logfn (...args) {
	// Log to console
	console.log('[Master]', ...args);
	// Log to file
	fs.appendFile(logfile, `[Master] ${args.join(' ')}\n`, errcb);
}

function errfn (...args) {
	// Log to console
	console.error('[ERROR]', ...args);
	// Log to file
	fs.appendFile(logfile, `[ERROR] ${args.join(' ')}\n`, errcb);
}

const mgr = new Manager({
		waitformsg: true,
		relaunch: true,
		relaunchtime: 1000
	},
	logfn,
	errfn
);

// Add signal handler
function sigfn () {
	console.log('');
	mgr.log('Caught signal, exiting...');

	// Shut down all running processes
	// Wait for all processes to exit or timeout before continuing
	Promise.all(mgr.shutdown().map(
		x => x.catch(err => err)
	)).then(procs => {
		mgr.log('Shutting down master...');
		process.exitCode = 0;
	}).catch(err => {
		if (_.isError(err)) {
			err = _.toString(err.stack);
		}
		mgr.err(`Error during shutdown: ${err}`);
		process.exitCode = 1;
	});
};
process.on('SIGINT', sigfn);
process.on('SIGTERM', sigfn);

// Add child log/err handlers
mgr.on('log', (proc, msg) => {
	let name = `[${_.upperFirst(proc.name)}]`;
	console.log(name, msg);
	fs.appendFile(logfile, `${name} ${msg}\n`, errcb);
});
mgr.on('err', (proc, msg) => {
	let name = `[${_.upperFirst(proc.name)}]`;
	console.error(name, msg);
	fs.appendFile(logfile, `${name} ${msg}\n`, errcb);
});

// Add child relaunch handlers
mgr.on('restart', promise => {
	mgr.sendall('pause');
	mgr.waitall('ready').then(() => {
		mgr.log('All other processes ready');
		return promise;
	}).then(proc => {
		return mgr.sendall('ready').then(() => mgr.log('Sent ready signal'));
	}).catch(e => mgr.err(e));
});

mgr.log(`Started: master, PID: ${process.pid}`);

// Launch child processes
Promise.all(childnames.map(name => {
	return mgr.launch(`./lib/${name}.js`, name, {addtoenv: {childname: name}});
})).then(
	procs => {
		mgr.log('All processes started');
		return mgr.sendall('ready').then(() => mgr.log('Sent ready signal'), e => mgr.err(e));
	},
	err => {
		// FIXME: return all processes first, then check for errors, so all can be shutdown
		mgr.err('One or more processes could not be started; exiting...');
		return mgr.shutdown();
	}
);

// Kick back, relax?

