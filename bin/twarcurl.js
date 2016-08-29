#!/usr/bin/env node
'use strict';

const util = require('util');
util.inspect.defaultOptions.colors = true;
util.inspect.defaultOptions.depth = null;

var argv = require('yargs')
	.usage('Usage: $0 [options] <path>')
	.options({
		'd': {
			alias: 'default_user',
			describe: 'use default user_id for request',
			type: 'boolean'
		},
		'u': {
			alias: 'user_id',
			describe: 'use this user_id for request',
			nargs: 1,
			requiresArg: true,
			type: 'string'
		},
		'n': {
			alias: 'screen_name',
			describe: 'use this screen_name for request',
			nargs: 1,
			requiresArg: true,
			type: 'string'
		},
		'i': {
			alias: 'id',
			describe: 'use this item id for request',
			nargs: 1,
			requiresArg: true,
			type: 'string'
		},
		's': {
			alias: 'since_id',
			describe: 'return only tweets since this id',
			nargs: 1,
			requiresArg: true,
			type: 'string'
		},
		'm': {
			alias: 'max_id',
			describe: 'return only tweets up to and including this id',
			nargs: 1,
			requiresArg: true,
			type: 'string'
		},
		'c': {
			alias: 'count',
			describe: 'number of tweets to retrieve',
			nargs: 1,
			requiresArg: true,
			type: 'number'
		},
		'g': {
			alias: 'stringify_ids',
			describe: 'return friend/follower ids as strings',
			type: 'boolean'
		},
		't': {
			alias: 'trim_user',
			describe: 'truncate returned user objects',
			type: 'boolean'
		},
		'p': {
			alias: 'post',
			describe: 'send POST request instead of GET',
			type: 'boolean'
		}
	})
	.string('_')
	.help('h')
	.alias('h', 'help')
	.demand(1, 1)
	.strict()
	.check((hash, args) => {
		let num = 0;
		if (hash.default_user) num++;
		if (hash.user_id) num++;
		if (hash.screen_name) num++;
		if (num > 1) {
			throw new Error('Cannot specify more than one of default_user, user_id, and screen_name options');
		}
		return true;
	})
	.argv;

// console.log(util.inspect(argv));

const _ = require('lodash');
const Twitter = require('twitter');

// Config
const appcfg = _.defaultsDeep(
	{},
	require('../cfg/user.json'),
	require('../cfg/config.json')
);

// Twitter setup
const twitcfg = _.defaultsDeep(
	{
		request_options: {
			headers: {
				'User-Agent': 'rn-twarc/0.0.1'
			}
		}
	},
	require('../cfg/access.json'),
	require('../cfg/consumer.json')
);
const twit = new Twitter(twitcfg);
const paramnames = ['since_id', 'max_id', 'count', 'stringify_ids', 'trim_user'];

var params = {};

if (argv.screen_name) {
	params.screen_name = (_.isArray(argv.screen_name)) ? argv.screen_name.join(',') : argv.screen_name;
}
else if (argv.user_id) {
	params.user_id = (_.isArray(argv.user_id)) ? argv.user_id.join(',') : argv.user_id;
}
else if (argv.default_user) {
	params.user_id = appcfg.user.id_str;
}

if (argv.id) {
	params.id = (_.isArray(argv.id)) ? argv.id.join(',') : argv.id;
}

// Check/include other options
for (let name of paramnames) {
	if (argv[name]) {
		params[name] = argv[name];
	}
}

// console.log(`Path: ${argv._[0]}`);
// console.log(`Params:`, util.inspect(params));

// GO
twit.get(argv._[0], params).then(
	data => {
		process.stdout.write(JSON.stringify(data, null, 2) + '\n');
	},
	err => {
		let error;
		if (_.isError(err)) {
			error = util.inspect(err.message);
		}
		else if (_.isObject(err)) {
			error = JSON.stringify(err, null, 2) + '\n';
		}
		else {
			error = util.inspect(err);
		}
		process.stderr.write(error);
	}
);

