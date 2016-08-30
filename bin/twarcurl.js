#!/usr/bin/env node
'use strict';

const util = require('util');
util.inspect.defaultOptions.colors = true;
util.inspect.defaultOptions.depth = null;

const Arghs = require('../lib/arghs.js');
var argv = new Arghs({
	named: ['path'],
	options: {
		'user_id': 'array',
		'screen_name': 'array',
		'id': 'array',
		'since_id': 'string',
		'max_id': 'string',
		'count': 'string',
		'default_user': 'bool',
		'stringify_ids': 'bool',
		'trim_user': 'bool',
		'post': 'bool',
		'verbose': 'count'
	},
	aliases: {
		'd': 'default_user',
		'u': 'user_id',
		'n': 'screen_name',
		'i': 'id',
		's': 'since_id',
		'm': 'max_id',
		'c': 'count',
		'g': 'stringify_ids',
		't': 'trim_user',
		'p': 'post',
		'v': 'verbose'
	},
	help: {
		'default_user': 'use configured user_id for request',
		'user_id': 'use user_id(s) for request',
		'screen_name': 'use screen_name(s) for request',
		'id': 'use item id(s) for request',
		'since_id': 'return only tweets since this id',
		'max_id': 'return only tweets up to and including this id',
		'count': 'number of tweets to retrieve',
		'stringify_ids': 'return friend/follower ids as strings',
		'trim_user': 'truncate returned user objects',
		'post': 'send POST request instead of GET',
		'verbose': 'show additional information for each invocation'
	},
	usage: 'Usage: $1 [OPTIONS...] <PATH>\nMake Twitter API request to PATH'
}).parse();

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

var params = {};

// Separate path from params
var apipath = argv.path;
delete argv.path;

// Check for conflicting user/name options
if (argv.default_user) {
	if (argv.user_id || argv.screen_name) {
		throw new Error('Cannot specify more than one of default_user, user_id, and screen_name options');
	}
	argv.user_id = appcfg.user.id_str;
	delete argv.default_user;
}
else if (argv.user_id && argv.screen_name) {
	throw new Error('Cannot specify more than one of default_user, user_id, and screen_name options');
}

// Join multiply-given options
for (let arg of Object.keys(argv)) {
	if (_.isArray(argv[arg])) {
		argv[arg] = argv[arg].join(',');
	}
}

// Add in extra args
for (let extra of Object.keys(argv.$)) {
	argv[extra] = _.isArray(argv.$[extra]) ? argv.$[extra].join(',') : argv.$[extra];
}

if (argv.verbose) {
	delete argv.verbose;
	console.error(`Path: ${apipath}`);
	console.error(`Params:`, util.inspect(argv), '\n');
}

// GO
twit.get(apipath, argv).then(
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

