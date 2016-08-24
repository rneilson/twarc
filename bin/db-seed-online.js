#!/usr/bin/env node
'use strict';

const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const ipc = require('node-ipc');

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

		// Convert to JSON
		let eventlist = JSON.parse(str);

		// Feed each event to writer process
		for (let event of eventlist) {
			if (_.has(event, 'type') && _.has(event, 'data')) {
				ipc.of.writer.emit(event.type, event.data);
			}
		}

		console.log(`Processed ${filename}`);
	}
	catch (e) {
		console.error(`Error processing ${filename}:`);
		console.error(e);
	}
}

function tickstep (iter, last, func, res, rej) {
	if (last.done) {
		res(last.value);
	}
	else {
		try {
			// Call func for this iteration
			let newval = (func) ? func(last.value) : last.value;
			// Schedule next iterator step, passing in previous value (for generators)
			// TODO: check for thenable
			process.nextTick(tickstep, iter, iter.next(newval), func, res, rej);
		}
		catch (e) {
			// Reject original promise
			rej(e);
		}
	}
}

// TODO: Move to class to reuse elsewhere (along with tickstep() of course)
function itertick (iterable, iterfunc) {
	let iterator = iterable[Symbol.iterator]();

	return new Promise(function (resolve, reject) {
		// Start iterator and schedule stepper function
		process.nextTick(tickstep, iterator, iterator.next(), iterfunc, resolve, reject);
	});
}
