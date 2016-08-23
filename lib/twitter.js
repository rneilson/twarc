'use strict';

const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const ipc = require('node-ipc');
const Twitter = require('twitter');
const Filters = require('./filters.js');
const Managed = require('./managed.js');

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

// Promisify
// function getAsync () {}

// User info
const userinfo = new Map();

// Filter setup
const filters = new Filters(appcfg);

// IPC setup
const mgd = new Managed(
	{waitforgo: true},
	logfn.bind(null, 'log'),
	logfn.bind(null, 'err')
);
_.assign(ipc.config, {
	appspace: 'twarc',
	socketRoot: path.resolve(appcfg.sockpath) + path.sep,
	id: process.env.childname,
	silent: true
});

// Stream params
var twistream;
var params = {
	with: 'user',
	stringify_friend_ids: true,
};

// Signal handlers
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {
	// Close stream
	if (twistream) {
		twistream.destroy();
	}
	// Close sockets
	// ipc.server.broadcast('terminate', {});
	ipc.server.sockets.forEach(s => s.end());
	ipc.server.stop();

	mgd.log('Caught signal, exiting...').then(() => {
		return 0;
	}, e => {
		console.error(e);
		return 1;
	}).then(code => {
		process.exitCode = code;
		process.disconnect();
	});
});


// Misc funcs
function logfn (type, data) {
	if (data) {
		if (_.isError(data)) {
			data = _.toString(data.stack);
		}
		return mgd.sendmsg({type, data}).catch(e => console.log(e));
	}
	return Promise.resolve();
}

function writefn (...args) {

	function append (data) {
		ipc.server.broadcast(data.type, data.data);
	}

	for (let i = 0, len = args.length; i < len; i++) {
		let arg = args[i];
		let user, tweet;

		if (_.has(arg, 'type')) {
			switch(arg.type) {
				case 'log':
					mgd.log(arg.data);
					break;

				case 'user':
					setuser(arg.data.user, arg.data.time);
					append(arg);
					break;

				case 'user_tweet':
				case 'other_tweet':
					// Pull user out of tweet
					[user, tweet] = updateuser(arg.data);
					if (user) {
						// Write user info first
						append({type: 'user', data: user});
					}
					// Can now write original object (tweet obj modified)
					append(arg);
					break;

				default:
					append(arg);
			}
		}
	}

}

function getuser (user_or_id) {
	if (_.isString(user_or_id)) {
		return userinfo.get(user_or_id);
	}
	else if (_.has(user_or_id, 'id_str')) {
		return userinfo.get(user_or_id.id_str);
	}
	// Return undefined
	return;
}

function setuser (user, time) {
	let data = {user, time};
	userinfo.set(user.id_str, data);
	return data;
}

// Warning: mutates original!
function updateuser (source) {
	let [user, tweet] = Filters.splituser(source);
	let userdata;

	// Only do update check if full user object
	if (user) {
		let date_u;
		if (_.has(tweet, 'timestamp_ms')) {
			date_u = new Date(parseInt(tweet.timestamp_ms));
		}
		else {
			// Supply timestamp_ms if not present
			date_u = new Date(tweet.created_at)
			tweet.timestamp_ms = date_u.valueOf().toString();
		}

		// Get currently stored user info
		let tmp = getuser(user);
		let date_t = _.has(tmp, 'time') ? new Date(tmp.time) : undefined;

		// Now compare
		if (date_t === undefined ||
			(date_u > date_t && !Filters.equaluser(tmp.user, user)))
		{
			userdata = setuser(user, date_u.valueOf());
			// mgd.log(`[User update: ${user.name} (@${user.screen_name})]`);
		}
	}

	return [userdata, tweet];
}


// Start stream on ready?
mgd.waitfor('ready').then(() => {
	twistream = twit.stream('user', params)
		.on('error', mgd.err.bind(mgd))
		.on('friends', fri => {
			// Add id to followed set
			_.forEach(fri.friends_str, (x => filters.following.add(x)));
			writefn({
				type: 'log',
				data: `[Following: ${filters.following.size}]`
			});
		})
		.on('user_update', ev => {
			let upd = ev.target_object;
			writefn({
				type: 'log',
				data: `[User update: ${upd.name} (@${upd.screen_name})]`
			}, {
				type: 'user',
				data: {
					user: upd,
					time: Date.now()
				}
			});
		})
		.on('follow', ev => {
			if (filters.event_user_src(ev)) {
				filters.following.add(ev.target.id_str);
				writefn({
					type: 'log',
					data: `[Followed @${ev.target.screen_name}]\n[Following: ${filters.following.size}]`
				});
			}
		})
		.on('unfollow', ev => {
			// Can assume user is unfollowing
			filters.following.delete(ev.target.id_str);
			writefn({
				type: 'log',
				data: `[Unfollowed @${ev.target.screen_name}]\n[Following: ${filters.following.size}]`
			});

		})
		.on('favorite', ev => {
			let tweet = ev.target_object;

			// Only match user's favorites
			if (filters.event_user_src(ev) && filters.tweet(tweet)) {
				// Store favorite regardless
				writefn({
					type: 'favorite',
					data: {
						id_str: tweet.id_str,
						time: new Date(ev.created_at).valueOf()
					}
				}, ...filters.on_favorite(tweet));
			}
		})
		.on('unfavorite', ev => {
			let tweet = ev.target_object;

			// Only match user's favorites
			if (filters.event_user_src(ev) && filters.tweet(tweet)) {
				// Store favorite regardless
				writefn({
					type: 'log',
					data: `[Unfavorite] ${Filters.format(tweet)}`
				},{
					type: 'unfavorite',
					data: {
						id_str: tweet.id_str,
						time: new Date(ev.created_at).valueOf()
					}
				});
			}
		})
		.on('quoted_tweet', ev => {
			// Only catch others' quotes (we'll catch our own in the 'data' event)
			if (filters.event_user_tgt(ev)) {
				let tweet = ev.target_object;
				// Let replies and mentions get handled by the actual tweet in the stream
				if (!filters.reply_to_user(tweet) && !filters.mention(tweet)) {
					writefn(...filters.on_quote(tweet));
				}
			}
		})
		.on('delete', ev => {
			// Handle deletes
			let del = ev.delete;
			writefn({
				type: 'log',
				data: `[Delete ${del.status.id_str}]`
			}, {
				type: 'delete',
				data: {
					id_str: del.status.id_str,
					time: new Date(parseInt(del.timestamp_ms)).valueOf()
				}
			});
		})
		.on('data', data => {
			// Handle tweets
			if (filters.tweet(data)) {
				// Pass to appropriate func
				if (filters.retweet(data)) {
					if (filters.user(data.user) || filters.mention(data)) {
						writefn(...filters.on_rt(data));
					}
				}
				else if (filters.reply(data)) {
					writefn(...filters.on_reply(data));
				}
				else if (filters.quote(data)) {
					writefn(...filters.on_quote(data));
				}
				else if (filters.user(data.user)) {
					writefn(...filters.on_user_tweet(data));
				}
				else if (filters.mention(data)) {
					writefn(...filters.on_mention(data));
				}
				else {
					// TODO: ignore?
				}
			}
			else {
				// TODO: anything else we want to handle?
			}
		});
		// TODO: unfavorite
});

// Pause writing if another process dies
mgd.on('pause', () => {
	// TODO: actually pause writing events to IPC socket
	mgd.log('Stream paused');
	mgd.waitfor('ready').then(() => {
		// TODO: actually unpause writing events to IPC socket
		mgd.log('Stream resumed');
	});
});

// Okay...GO!
ipc.serve(() => {
	ipc.server.on('connect', socket => {
		socket.on('end', () => {
			socket.end();
		});
	});
	mgd.go();
});
ipc.server.start();

