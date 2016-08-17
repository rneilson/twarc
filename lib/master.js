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

function errcb (err) {
	if (err) {
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
		relaunch: true
	},
	logfn,
	errfn
);

// Add SIGINT handler
function sigfn () {
	mgr.log('\nCaught signal, exiting...');

	// Shut down all running processes
	// Wait for processes to exit
	Promise.all(mgr.shutdown().map(
		x => x.then(
			proc => `${proc.name} exited successfully`,
			err => err
		)
	)).then(procs => {
		for (let status of procs) {
			mgr.log(status);
		}
		mgr.log('Shutting down master...');
		process.exitCode = 0;
	}).catch(err => {
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

// Launch child processes
// const childnames = ['writer', 'twitter', 'archiver', 'websrv'];
const childnames = ['twitter'];

_.forEach(childnames, name => {
	mgr.launch(`./lib/${name}.js`, name, {addtoenv: {childname: name}});
	// TODO: anything for .then()?
});

// Kick back, relax?

