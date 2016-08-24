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
	stopRetrying: 0
});

// Get file list
const filenames = process.argv.slice(2);

// Go
ipc.connectTo('writer', () => {
	ipc.of.writer.on('error', console.error.bind(console));
	ipc.of.writer.on('disconnect', () => {
		console.log('Disconnected from writer process');
	});
	ipc.of.writer.on('connect', () => {
		console.log(`Connected to writer process`);
		itertick(filenames, loadfile).then(() => {
			console.log('Finished, disconnecting...');
			ipc.disconnect('writer');
		});
	});
});

// Funcs
function loadfile (name) {
	let filename = path.resolve(name);

	try {
		// Read file into memory
		let str = fs.readFileSync(filename, {encoding: 'utf8'});

		// Convert from JSON
		let eventlist = JSON.parse(str);

		// Send queue to writer process
		ipc.of.writer.emit('queue', eventlist);

		console.log(`Processed ${filename}`);
	}
	catch (e) {
		console.error(`Error processing ${filename}:`);
		console.error(e);
	}
}

