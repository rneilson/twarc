#!/usr/bin/env node
'use strict';

const _ = require('lodash');
const path = require('path');
const util = require('util');
const lmdb = require('../node-lmdb');
const Filters = require('../lib/filters.js');

// Config
const appcfg = _.defaultsDeep(
	{},
	require('../cfg/user.json'),
	require('../cfg/config.json')
);

// Filter setup
const filters = new Filters(appcfg);

// LMDB
var dbe = new lmdb.Env();
dbe.open({
	path: path.resolve(process.cwd(), '../data/db/'),
	mapSize: 1 * 1024 * 1024 * 1024,	// 1 GiB
	maxDbs: 8
});
const dbs = {};
const names = ['users', 'screennames', 'tweets', 'userdates', 'otherdates', 'favids', 'favdates'];
for (let name of names) {
	dbs[name] = dbe.openDbi({name, create: true});
}

var txn, cur, key, val, writer, idxstr, prefix = '';

// TEMP
// Print db stats to console
txn = dbe.beginTxn({readOnly: true});
for (let db of names) {
	// console.log(`\nDB stats for ${db}:`);
	// console.dir(dbs[db].stat(txn));
	process.stderr.write(`\nDB stats for ${db}:\n`);
	process.stderr.write(util.inspect(dbs[db].stat(txn), {colors:true}) + '\n');
}
txn.commit();

// Output leading '['
process.stdout.write('[\n');
// TODO: output leading log summary


// Output users
txn = dbe.beginTxn({readOnly: true});
cur = new lmdb.Cursor(txn, dbs.users);

writer = (k, v) => writefn('user', JSON.parse(v.toString()));

for (key = cur.goToFirst(); key; key = cur.goToNext()) {
	cur.getCurrentBinaryUnsafe(writer);
}

cur.close();
txn.commit();


// Output tweets
txn = dbe.beginTxn({readOnly: true});
cur = new lmdb.Cursor(txn, dbs.tweets);

writer = (k, v) => {
	let t = JSON.parse(v.toString());
	writefn(filters.user(t) ? 'user_tweet' : 'other_tweet', t);
};

for (key = cur.goToFirst(); key; key = cur.goToNext()) {
	cur.getCurrentBinaryUnsafe(writer);
}

cur.close();
txn.commit();


// Output favorites
txn = dbe.beginTxn({readOnly: true});
cur = new lmdb.Cursor(txn, dbs.favids);

writer = (k, v) => writefn('favorite', {id_str: k, time: parseInt(v)});

for (key = cur.goToFirst(); key; key = cur.goToNext()) {
	cur.getCurrentString(writer);
}

cur.close();
txn.commit();


// Output indices
writeindex(dbs.screennames, 'user_index');
writeindex(dbs.userdates, 'user_tweet_index');
writeindex(dbs.otherdates, 'other_tweet_index');
writeindex(dbs.favdates, 'favorite_index');


// Output trailing ']'
process.stdout.write('\n]\n');

// Close dbs
for (let name of names) {
	dbs[name].close();
}
dbe.close();


function writefn (type, data) {
	process.stdout.write(prefix + JSON.stringify({type, data}, null, 2));
	if (!prefix) {
		prefix = ',\n';
	}
}

function writeindex (db, type) {
	txn = dbe.beginTxn({readOnly: true});
	cur = new lmdb.Cursor(txn, db);

	key = cur.goToFirst();
	if (key !== null) {
		cur.getCurrentString((k, v) => {
			idxstr = prefix + `{\n  "type": "${type},\n  "data": {\n    "${k}": "${v}"`;
		});

		while (cur.goToNext()) {
			cur.getCurrentString((k, v) => {
				idxstr += `,\n    "${k}": "${v}"`;
			});
		}

		idxstr += `\n  }\n}`;
		process.stdout.write(idxstr);
	}

	cur.close();
	txn.commit();
}
