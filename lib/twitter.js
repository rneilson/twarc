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
const writestream = {
	shutdown: false,
	paused: true,
	queue: []
};

// Stream params
var twistream;
var streamparams = {
	with: 'user',
	stringify_friend_ids: true,
};
const streamretry = {
	retries: 2,
	retrynum: 0,
	retrydelay: 5000,
	longdelay: 15 * 60 * 1000,	// 15 mins
	shutdown: false,
	timeout: null,
};

// Signal handlers
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {
	// Close streams
	writestream.shutdown = true;
	streamretry.shutdown = true;
	if (streamretry.timeout) {
		clearTimeout(streamretry.timeout);
	}
	if (twistream) {
		twistream.destroy();
	}

	// Close writer IPC socket
	if (ipc.of.writer) {
		ipc.of.writer.config.stopRetrying = true;
		if (ipc.of.writer.socket) {
			ipc.of.writer.socket.end();
		}
	}

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
function datestr (d) {
	let dt = d ? new Date(d) : new Date();
	return _.replace(dt.toISOString(), /[^0-9]/g, '');
}

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
	var sendq = [];

	function append (msg) {
		if (writestream.paused) {
			writestream.queue.push(msg);
		}
		else {
			sendq.push(msg);
		}
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

	if (sendq.length > 1) {
		ipc.of.writer.emit('queue', sendq);
	}
	else if (sendq.length == 1) {
		ipc.of.writer.emit(sendq[0].type, sendq[0].data);
	}
	
	return sendq.length;
}

function pause () {
	let oldpause = writestream.paused;
	writestream.paused = true;
	if (!oldpause && !writestream.shutdown) {
		mgd.log('Write stream paused');
	}
}

function unpause () {
	let oldpause = writestream.paused;
	writestream.paused = false;
	if (oldpause && !writestream.shutdown) {
		mgd.log('Write stream active');
	}
	// Empty queue
	let sent = writefn(...writestream.queue);
	writestream.queue = [];
	if (sent > 0 && !writestream.shutdown) {
		mgd.log(`Sent ${sent} queued items`);
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

function retrystream () {
	if (streamretry.shutdown) {
		// Shutting down, do nothing
		return;
	}

	let delay;

	// Check current retries, do long delay if max retries met
	if (++streamretry.retrynum > streamretry.retries) {
		// Make fresh retry state
		streamretry.retrynum = 0;
		// Set long delay until next retry
		delay = streamretry.longdelay;
		mgd.err(`Stream disconnected, retrying in ${Math.round(delay / 60000)}m`);
	}
	else {
		// Set delay until next retry
		delay = streamretry.retrydelay;
		mgd.err(`Stream disconnected, retrying in ${Math.round(delay / 1000)}s`);
	}

	// Wait for delay, then attempt restarting stream
	streamretry.timeout = setTimeout(startstream, delay);
}

function startstream () {
	twistream = twit.stream('user', streamparams)
		.on('error', mgd.err.bind(mgd))
		.on('end', retrystream)
		.on('friends', fri => {
			// Add id to followed set
			_.forEach(fri.friends_str, (x => filters.following.add(x)));
			writefn({
				type: 'log',
				data: `[Following: ${filters.following.size}]`
			}, {
				type: 'following',
				data: {
					list: Array.from(filters.following),
					time: Date.now()
				}
			});
			// // TEMP
			// let followlist = Array.from(filters.following.values());
			// let followlog = JSON.stringify({type: 'following', data: followlist}, null, 2) + '\n';
			// fs.writeFile(`tmp/following-${datestr().substr(0,14)}.json`, followlog, e => {
			// 	if (e) mgd.err(e);
			// });
			// // END TEMP
		})
		.on('user_update', ev => {
			let upd = ev.source;
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
				}, {
					type: 'following',
					data: {
						list: Array.from(filters.following),
						time: Date.now()
					}
				});
			}
		})
		.on('unfollow', ev => {
			// Can assume user is unfollowing
			filters.following.delete(ev.target.id_str);
			writefn({
				type: 'log',
				data: `[Unfollowed @${ev.target.screen_name}]\n[Following: ${filters.following.size}]`
			}, {
				type: 'following',
				data: {
					list: Array.from(filters.following),
					time: Date.now()
				}
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
					user_id_str: del.status.user_id_str,
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
}

// // Unpause queue on ready
// mgd.waitfor('ready').then(unpause);

// // Pause writing if another process dies
// mgd.on('pause', () => {
// 	mgd.waitfor('ready').then(unpause);
// });

// Okay...GO!
startstream();
// Send events to writer's socket
// Add delay to give writer proc some time
setTimeout(() => {
	ipc.connectTo('writer', () => {
		ipc.of.writer.on('disconnect', pause);
		ipc.of.writer.on('connect', () => {
			ipc.of.writer.socket.on('end', () => ipc.of.writer.socket.end());
			mgd.go();
			mgd.log('Connected to Writer socket');
			unpause();
			// This will (should) send ready to master once socket reconnects
			// So no need to directly handle 'pause' event
			// mgd.sendmsg('ready');
		});
	});
}, 250);

