#!/usr/bin/env node
'use strict';

const _ = require('lodash');
const path = require('path');
const util = require('util');
const lmdb = require('node-lmdb');
const Filters = require('../lib/filters.js');
const DBReader = require('../lib/dbread.js');

// Find base directory for consistency
const basedir = path.resolve(__dirname, '..');

// Config
const appcfg = _.defaultsDeep(
	{},
	require('../cfg/user.json'),
	require('../cfg/config.json')
);

// Filter setup
const filters = new Filters(appcfg);

// LMDB
var dbr = new DBReader({
	path: path.isAbsolute(appcfg.dbpath) ? appcfg.dbpath : path.resolve(basedir, appcfg.dbpath),
	user_id_str: appcfg.user.id_str
});

var txn, cur, key, val, acc, writer, prefix = '';

// TEMP
// Print db stats to console
txn = dbr.begin();
for (let name of DBReader.dbnamelist()) {
	process.stderr.write(`\nDB stats for ${name}:\n`);
	process.stderr.write(util.inspect(dbr.dbs[name].stat(txn), {colors:true}) + '\n');
}
txn.commit();

// Output leading '['
process.stdout.write('[\n');
// TODO: output leading log summary


// Output users
for (let u of dbr.dbs.users.values()) {
	writefn('user', u);
}

// Output tweets
for (let t of dbr.dbs.tweets.values()) {
	if (t.deleted) {
		// Convert from stored format to broadcast format
		writefn('delete', {
			id_str: t.id_str,
			user_id_str: t.user.id_str,
			time: t.deleted
		});
	}
	else {
		writefn(filters.user(t.user) ? 'user_tweet' : 'other_tweet', t);
	}
}

// Output favorites
for (let [k, t] of dbr.dbs.favids.entries()) {
	writefn('favorite', {id_str: k, time: t});
}

// Output indices
for (let db of dbr.indices) {
	let res = [];
	let type = 'index_' + db.name;

	for (let [k, v] of db.entries()) {
		res.push(`"${k}": "${v}"`);
	}

	process.stdout.write(prefix + `{\n  "type": "${type}",\n  "data": {\n    ` + res.join(',\n    ') + '\n  }\n}');
}

// Output status
acc = {};
for (let [k, v] of dbr.dbs.status.entries()) {
	_.set(acc, k, v);
}
writefn('status_raw', acc);

// Output trailing ']'
process.stdout.write('\n]\n');

dbr.close();


function writefn (type, data) {
	process.stdout.write(prefix + JSON.stringify({type, data}, null, 2));
	if (!prefix) {
		prefix = ',\n';
	}
}
