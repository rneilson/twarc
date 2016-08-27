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
	// noSync: true
});

// Get file list
const filenames = process.argv.slice(2);

// GO!
for (let fname of filenames) {
	loadfile(fname);
}

// // Sync and close
// dbw.sync(err => {
// 	if (err) {
// 		console.error(err);
// 	}
// 	dbw.close();
// });

console.log('Finished!');


// Funcs
function loadfile (name) {
	const types = ['user', 'user_tweet', 'other_tweet', 'delete', 'favorite', 'unfavorite'];
	let count = {
		'user': 0,
		'user_tweet': 0,
		'other_tweet': 0,
		'delete': 0,
		'favorite': 0,
		'unfavorite': 0
	};
	let filename = path.resolve(name);
	let ret = false;
	let total = 0;

	function writefn (type, data, txn) {
		let retw = false;

		switch (type) {
			case 'queue':
				retw = writeq(data);
				break;
			case 'status':
				retw = dbw.setstatus('', data, txn);
				break;
			case 'user':
				retw = dbw.writeuser(data, txn);
				break;
			case 'user_tweet':
				retw = dbw.writetweet(data, txn);
				break;
			case 'other_tweet':
				retw = dbw.writetweet(data, txn);
				break;
			case 'delete':
				retw = dbw.deletetweet(data, txn);
				break;
			case 'favorite':
				retw = dbw.writefav(data, txn);
				break;
			case 'unfavorite':
				retw = dbw.deletefav(data, txn);
				break;
		}

		return retw;
	}

	function writeq (queue) {
		let retq = false;

		// Open transaction
		let qtxn = dbw.begin();

		try {
			// Recursively call
			for (let i = 0; i < queue.length; i++) {
				let item = queue[i];
				if (_.has(item, 'type') && _.has(item, 'data')) {
					// Leave return value to end of queue, but return true if any write succeeds
					if (writefn(item.type, item.data, qtxn)) {
						retq = true;
						if (_.has(count, item.type)) {
							count[item.type]++;
						}
					}
				}
			}
			qtxn.commit();
		}
		catch (e) {
			qtxn.abort();
			console.error(e);
			retq = false;
		}

		return retq;
	}

	try {
		// Read file into memory
		let str = fs.readFileSync(filename, {encoding: 'utf8'});

		// Convert to JSON
		let eventlist = JSON.parse(str);

		if (eventlist.length > 0) {
			console.log(`Processing ${filename}, ${eventlist.length} items`);
			if (writeq(eventlist)) {
				let counts = [];
				for (let name of types) {
					let num = count[name];
					if (num > 0) {
						total += num;
						counts.push(`${num} ${name}${num > 1 ? 's' : ''}`);
					}
				}
				console.log(`Processed ${eventlist.length} items, updated ${total} (${counts.join(', ')})`);
			}
			else {
				console.log(`Processed ${eventlist.length} items; all items up-to-date`);
			}

		}
		else {
			console.log(`No items to process in ${filename}`);
		}
	}
	catch (e) {
		console.error(`Error processing ${filename}:`);
		console.error(e);
	}
}

