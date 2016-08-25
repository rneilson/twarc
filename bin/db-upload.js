#!/usr/bin/env node
'use strict';

const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const ipc = require('node-ipc');
const itertick = require('../lib/itertick.js');

// Config
const appcfg = _.defaultsDeep(
	{},
	require('../cfg/user.json'),
	require('../cfg/config.json')
);

// Find base directory for consistency
const sockpath = (path.isAbsolute(appcfg.sockpath) ? appcfg.sockpath : path.resolve(__dirname, '..', appcfg.sockpath)) + path.sep;

// IPC setup
_.assign(ipc.config, {
	appspace: 'twarc',
	socketRoot: sockpath,
	id: path.basename(__filename, '.js'),
	silent: true,
	maxRetries: 0,
	// stopRetrying: 0
});

// Get file list
const filenames = process.argv.slice(2);

// Go
ipc.connectTo('writer', () => {
	ipc.of.writer.on('error', err => {
		console.error('Error connecting to writer process:', err.message || err);
	});
	ipc.of.writer.on('disconnect', () => {
		console.log('Disconnected from writer process');
	});
	ipc.of.writer.on('connect', () => {
		console.log(`Connected to writer process`);
		itertick(filenames, loadfile).then(
			() => {
				console.log('Finished, disconnecting...');
				return 0;
			},
			err => {
				console.error(err);
				return 1;
			}
		).then(code => {
			ipc.disconnect('writer');
			process.exitCode = code;
		});
	});
});

// Funcs
function loadfile (name) {
	let filename = path.resolve(name);
	let eventlist, send = false;

	try {
		// Read file into memory
		let str = fs.readFileSync(filename, {encoding: 'utf8'});
		// Convert from JSON
		eventlist = JSON.parse(str);
		send = true;
	}
	catch (e) {
		console.error(`Error processing ${filename}:`);
		console.error(e);
	}

	// Send queue to writer process
	// Don't *actually* want to try/catch here, so it'll reject the
	// itertick promise if there's a connection error while sending
	if (send) {
		if (!ipc.of.writer) {
			throw new Error('Writer process not available')
		}
		ipc.of.writer.emit('queue', eventlist);
		console.log(`Processed ${filename}`);
	}
}

