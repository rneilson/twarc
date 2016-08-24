#!/usr/bin/env node
'use strict';

const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const DBWriter = require('../lib/dbwrite.js');

// Config
const appcfg = _.defaultsDeep(
	{},
	require('../cfg/user.json'),
	require('../cfg/config.json')
);

// DB
const dbpath = path.isAbsolute(appcfg.dbpath) ? appcfg.dbpath : path.resolve(__dirname, '..', appcfg.dbpath);
const dbw = new DBWriter({
	path: dbpath,
	user_id_str: appcfg.user.id_str,
	noSync: true
});

// Get file list
const filenames = process.argv.slice(2);

// GO!
for (let fname of filenames) {
	loadfile(fname);
}

// Sync and close
dbw.sync(err => {
	if (err) {
		console.error(err);
	}
	dbw.close();
});

console.log('Finished!');


// Funcs
function loadfile (name) {
	let filename = path.resolve(name);

	try {
		// Read file into memory
		let str = fs.readFileSync(filename, {encoding: 'utf8'});

		// Convert to JSON
		let eventlist = JSON.parse(str);

		if (eventlist.length > 0) {
			console.log(`Processing ${filename}, ${eventlist.length} items`);
			
			// Check/write relevant events
			// Index events in a dumpstream aren't needed
			for (let event of eventlist) {
				switch (event.type) {
					case 'user':
						dbw.writeuser(event.data);
						break;
					case 'user_tweet':
						dbw.writetweet(event.data);
						break;
					case 'other_tweet':
						dbw.writetweet(event.data);
						break;
					case 'delete':
						dbw.deletetweet(event.data);
						break;
					case 'favorite':
						dbw.writefav(event.data);
						break;
					case 'unfavorite':
						dbw.deletefav(event.data);
						break;
				}
			}
		}
		console.log(`Processed ${filename}`);
	}
	catch (e) {
		console.error(`Error processing ${filename}:`);
		console.error(e);
	}
}

