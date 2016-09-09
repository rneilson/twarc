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
const dbw = new DBWriter({
	path: path.isAbsolute(appcfg.dbpath) ? appcfg.dbpath : path.resolve(__dirname, '..', appcfg.dbpath),
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
	const types = DBWriter.itemtypes();
	let filename = path.resolve(name);

	try {
		// Read file into memory
		let str = fs.readFileSync(filename, {encoding: 'utf8'});

		// Convert to JSON
		let eventlist = JSON.parse(str);

		if (eventlist.length > 0) {
			console.log(`Processing ${filename}, ${eventlist.length} items...`);
			let ret = dbw.writequeue(eventlist);
			if (ret) {
				let total = 0;
				let counts = [];
				let stastr = '';
				if (ret.status.size > 0) {
					let num = ret.status.size;
					total += num;
					stastr = '\nUpdated status items:';
					for (let st of ret.status) {
						stastr += `\n    ${st}`;
					}
					counts.push(`${num} status item${num > 1 ? 's' : ''}`);
				}
				for (let name of types) {
					let num = ret[name];
					if (num > 0) {
						total += num;
						counts.push(`${num} ${name}${num == 1 ? '' : name.endsWith('s') ? 'es' : 's'}`);
					}
				}
				console.log(`Updated ${total} items (${counts.join(', ')})` + stastr);
			}
			else {
				console.log(`All items up-to-date`);
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

