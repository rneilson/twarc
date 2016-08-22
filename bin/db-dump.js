#!/usr/bin/env node
'use strict';

const path = require('path');
const util = require('util');
const lmdb = require('../node-lmdb');

// LMDB
var dbe = new lmdb.Env();
dbe.open({
	path: path.resolve(process.cwd(), '../data/db/'),
	mapSize: 1 * 1024 * 1024 * 1024,	// 1 GiB
	maxDbs: 8
});
const dbs = {};
const names = ['users', 'screennames', 'tweets', 'userdates', 'otherdates', 'favdates'];
var txn, cur, key, val, writer, idxlist, prefix = '';

// Open dbs
for (let name of names) {
	dbs[name] = dbe.openDbi({name, create: true});
}

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
// Output leading log summary


// Output users
txn = dbe.beginTxn({readOnly: true});
cur = new lmdb.Cursor(txn, dbs.users);

writer = (k, v) => writefn('user', JSON.parse(v.toString()));

for (key = cur.goToFirst(); key; key = cur.goToNext()) {
	cur.getCurrentBinaryUnsafe(writer);
}

cur.close();
txn.commit();


// Output user tweets
txn = dbe.beginTxn({readOnly: true});
cur = new lmdb.Cursor(txn, dbs.userdates);

writer = (k, v) => {
	// Get tweet from other db
	let t = txn.getBinaryUnsafe(dbs.tweets, v);
	// Parse and write
	writefn('user_tweet', JSON.parse(t.toString()))
};

for (key = cur.goToFirst(); key; key = cur.goToNext()) {
	cur.getCurrentString(writer);
}

cur.close();
txn.commit();


// Output other tweets
txn = dbe.beginTxn({readOnly: true});
cur = new lmdb.Cursor(txn, dbs.otherdates);

writer = (k, v) => {
	// Get tweet from other db
	let t = txn.getBinaryUnsafe(dbs.tweets, v);
	// Parse and write
	writefn('other_tweet', JSON.parse(t.toString()))
};

for (key = cur.goToFirst(); key; key = cur.goToNext()) {
	cur.getCurrentString(writer);
}

cur.close();
txn.commit();


// Output favdates
txn = dbe.beginTxn({readOnly: true});
cur = new lmdb.Cursor(txn, dbs.favdates);

writer = (k, v) => writefn('favorite', JSON.parse(v.toString()));

for (key = cur.goToFirst(); key; key = cur.goToNext()) {
	cur.getCurrentBinaryUnsafe(writer);
}

cur.close();
txn.commit();


// Output user tweet index
txn = dbe.beginTxn({readOnly: true});
cur = new lmdb.Cursor(txn, dbs.userdates);
idxlist = [];

writer = (k, v) => idxlist.push({[k]: v});

for (key = cur.goToFirst(); key; key = cur.goToNext()) {
	cur.getCurrentString(writer);
}

writefn('user_tweet_index', idxlist);

cur.close();
txn.commit();


// Output other tweet index
txn = dbe.beginTxn({readOnly: true});
cur = new lmdb.Cursor(txn, dbs.otherdates);
idxlist = [];

writer = (k, v) => idxlist.push({[k]: v});

for (key = cur.goToFirst(); key; key = cur.goToNext()) {
	cur.getCurrentString(writer);
}

writefn('other_tweet_index', idxlist);

cur.close();
txn.commit();


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
