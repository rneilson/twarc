#!/usr/bin/env node
'use strict';

const _ = require('lodash');
const path = require('path');
const util = require('util');
const lmdb = require('../node-lmdb');
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


// Output status
txn = dbr.begin();
cur = new lmdb.Cursor(txn, dbr.dbs.status);

acc = {};
writer = (k, v) => _.set(acc, k, JSON.parse(v.toString()));

for (key = cur.goToFirst(); key; key = cur.goToNext()) {
	cur.getCurrentBinaryUnsafe(writer);
}

writefn('status_raw', acc);

cur.close();
txn.commit();


// Output users
txn = dbr.begin();
cur = new lmdb.Cursor(txn, dbr.dbs.users);

writer = (k, v) => writefn('user', JSON.parse(v.toString()));

for (key = cur.goToFirst(); key; key = cur.goToNext()) {
	cur.getCurrentBinaryUnsafe(writer);
}

cur.close();
txn.commit();


// Output tweets
txn = dbr.begin();
cur = new lmdb.Cursor(txn, dbr.dbs.tweets);

writer = (k, v) => {
	let t = JSON.parse(v.toString());
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
};

for (key = cur.goToFirst(); key; key = cur.goToNext()) {
	cur.getCurrentBinaryUnsafe(writer);
}

cur.close();
txn.commit();


// Output favorites
txn = dbr.begin();
cur = new lmdb.Cursor(txn, dbr.dbs.favids);

writer = (k, v) => writefn('favorite', {id_str: k, time: parseInt(v)});

for (key = cur.goToFirst(); key; key = cur.goToNext()) {
	cur.getCurrentString(writer);
}

cur.close();
txn.commit();


// Output indices
writeindex(dbr.dbs.names, 'user_index');
writeindex(dbr.dbs.userdates, 'user_tweet_index');
writeindex(dbr.dbs.otherdates, 'other_tweet_index');
writeindex(dbr.dbs.favdates, 'favorite_index');
writeindex(dbr.dbs.refs, 'reference_index');


// Output trailing ']'
process.stdout.write('\n]\n');

dbr.close();


function writefn (type, data) {
	process.stdout.write(prefix + JSON.stringify({type, data}, null, 2));
	if (!prefix) {
		prefix = ',\n';
	}
}

function writeindex (db, type) {
	txn = dbr.begin();
	cur = new lmdb.Cursor(txn, db);

	key = cur.goToFirst();
	if (key !== null) {
		cur.getCurrentString((k, v) => {
			if (!v.startsWith('[')) {
				v = `"${v}"`;
			}
			acc = prefix + `{\n  "type": "${type}",\n  "data": {\n    "${k}": ${v}`;
		});

		while (cur.goToNext()) {
			cur.getCurrentString((k, v) => {
				if (!v.startsWith('[')) {
					v = `"${v}"`;
				}
				acc += `,\n    "${k}": ${v}`;
			});
		}

		acc += `\n  }\n}`;
		process.stdout.write(acc);
	}

	cur.close();
	txn.commit();
}
