'use strict';

const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const ipc = require('node-ipc');
const Twitter = require('twitter');
const Filters = require('./filters.js');
const Managed = require('./managed.js');
const DBReader = require('./dbread.js');
const iterwait = require('./iterwait.js');

// Config
const appcfg = _.defaultsDeep(
	{},
	require('../cfg/user.json'),
	require('../cfg/config.json')
);

// Twitter setup
const getpaths = {
	timeline: {
		user: 'statuses/user_timeline',
		mentions: 'statuses/mentions_timeline',
		favorites: 'favorites/list'
	}
};
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

// Filter setup
const filters = new Filters(appcfg);

// DBReader setup
const dbr = new DBReader({
	user_id_str: appcfg.user.id_str,
	path: appcfg.dbpath
});

// User, tweet, timeline cache
const cache = {
	users: new Map(),
	tweets: new Map(),
	timeline: null
};

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
	lastping: null,
	maxping: 10 * 60 * 1000,	// 10 mins
	pingout: null
};
const writestream = {
	shutdown: false,
	paused: true,
	queue: []
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
	if (streamretry.pingout) {
		clearTimeout(streamretry.pingout);
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

// Okay...GO!
// Get current timeline since/max from db
cache.timeline = _.defaultsDeep(
	dbr.getstatus('timeline'),
	{
		user: {
			since_id: null,
			max_id: null
		},
		mentions: {
			since_id: null,
			max_id: null
		},
		favorites: {
			since_id: null,
			max_id: null
		}
	}
);
// Load following/blocked/muted sets, then start stream, then fetch current timelines
loadsets()
.then(startstream)
.then(() => {
	var reftime = Date.now();
	return iterwait(get_current_timelines(), 0)..then(items => {
		// Log the update
		mgd.log('Refreshed timelines: ' + (
			(items.length > 0)
			? `updated ${items.length} item${items.length > 1 ? 's' : ''}`
			: 'all items up-to-date')
		);
		// Now add updated status, and send batch to writer process
		items.push({type: 'status',	data: {timeline: cache.timeline, time: reftime}});
		writeitems(items);
	});
});
// Connect to writer's socket
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
// Aaaaand we're ready!


// Various functions
function loadsets () {
	// Load following, blocked, and muted lists from db
	for (let name of ['following', 'blocked', 'muted']) {
		let list = dbr.getstatus(name);
		if (list !== null) {
			filters.updateset(name, JSON.parse(list));
		}
	}
	return Promise.all([getblocked(), getmuted()]);
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

function updateitems (args, acc) {
	acc = acc || [];
	args = _.isArray(args) ? args : [args];

	for (let i = 0, len = args.length; i < len; i++) {
		let arg = args[i];
		let user, tweet;

		if (_.has(arg, 'type')) {
			switch(arg.type) {
				case 'user':
					// Do nothing if user blocked
					if (!filters.is_blocked(arg.data.user)) {
						setuser(arg.data.user, arg.data.time);
						acc.push(arg);
					}
					break;

				case 'user_tweet':
				case 'other_tweet':
					// Do nothing if user blocked
					if (!filters.is_blocked(arg.data.user)) {
						// Pull user out of tweet
						[user, tweet] = updateuser(arg.data);
						if (user) {
							// Write user info first
							acc.push({type: 'user', data: user});
						}
						// Can now write original object (tweet obj modified)
						// Check cache first, though
						if (!filters.is_muted(tweet.user) && updatetweet(tweet)) {
							acc.push(arg);
						}
					}
					break;

				case 'delete':
					// Always update cache with delete
					updatetweet(arg.data, true);
					acc.push(arg);
					break;

				default:
					acc.push(arg);
			}
		}
	}

	return acc;
}

function writeitems (args) {
	if (writestream.paused) {
		writestream.queue.push(...args);
		return 0;
	}
	else {
		if (args.length > 1) {
			ipc.of.writer.emit('queue', args);
		}
		else if (args.length == 1) {
			ipc.of.writer.emit(args[0].type, args[0].data);
		}
		return args.length;
	}
}

function writefn (...args) {
	var tosend = [];
	var counts = {};

	// Peel out log items, count & queue rest
	for (let i = 0; i < args.length; i++) {
		let msg = args[i];

		if (msg.type === 'log') {
			mgd.log(msg.data);
		}
		else {
			counts[msg.type]++;
			tosend.push(msg);
		}
	}

	// Update items as req'd
	if (tosend.length > 0) {
		tosend = updateitems(tosend);
	}

	// Write/send
	counts.total = (tosend.length > 0) ? writeitems(tosend) : 0;

	return counts;
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
	let sent = writeitems(writestream.queue);
	writestream.queue = [];
	if (sent > 0 && !writestream.shutdown) {
		mgd.log(`Sent ${sent.total} queued items`);
	}
}

function getuser (user_or_id) {
	if (_.isString(user_or_id)) {
		return cache.users.get(user_or_id);
	}
	else if (_.has(user_or_id, 'id_str')) {
		return cache.users.get(user_or_id.id_str);
	}
	// Return undefined
	return;
}

function setuser (user, time) {
	let data = {user, time};
	// TODO: delete first for LRU semantics
	cache.users.set(user.id_str, data);
	// TODO: limit cache size!
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

function updatelist (name, newlist) {
	if (filters.updateset(name, newlist)) {
		writefn({
			type: 'log',
			data: `[${_.capitalize(name)}: ${filters[name].size}]`
		}, {
			type: 'status',
			data: {
				[name]: JSON.stringify(newlist),
				time: Date.now()
			}
		});
	}
}

function updatetweet (tweet, force) {
	if (force || !cache.tweets.has(tweet.id_str)) {
		// TODO: delete first for LRU semantics
		cache.tweets.set(tweet.id_str, tweet);
		return true;
	}
	// TODO: limit cache size!
	return false;
}

function parsetweet (data, silent) {
	var ret = [];

	// Handle tweets
	if (Filters.is_tweet(data)) {
		// Pass to appropriate func
		if (Filters.is_retweet(data)) {
			if (filters.user(data.user) || filters.mentioned(data)) {
				ret.push(...filters.on_rt(data, silent));
			}
		}
		else if (Filters.is_reply(data)) {
			ret.push(...filters.on_reply(data, silent));
		}
		else if (Filters.is_quote(data)) {
			ret.push(...filters.on_quote(data, silent));
		}
		else if (filters.user(data.user)) {
			ret.push(...filters.on_user_tweet(data, silent));
		}
		else if (filters.mentioned(data)) {
			ret.push(...filters.on_mention(data, silent));
		}
	}

	return ret;
}

// Done as generator so we can use it with iterwait
function* parsetimeline (results, type, timeline, max_id) {
	// Just in case the accumulator isn't initialized
	results = results || {};
	results.items = results.items || [];
	results.max_id = results.max_id || null;
	results.since_id = results.since_id || null;

	if (timeline.length > 0) {
		// Get since/max ids
		var new_max_id = timeline[0].id_str;
		var new_since_id = timeline[timeline.length - 1].id_str;

		// Check if we've only received one tweet matching max_id (meaning no more results)
		// Compare to received since_id, as in the 1-tweet case that'll be equal to received max_id
		if (max_id && new_since_id == max_id) {
			results.done = true;
		}
		else {
			// Iterate through and shove tweets through parser
			if (type === 'user' || type === 'mentions') {
				for (let tweet of timeline) {
					// If max_id is given, make sure we only parse below that
					// (If it's not the first batch, there'll be a duplicate of max_id)
					if (!max_id || Filters.compareid(tweet.id_str, max_id) < 0) {
						// TODO: check for replies to fetch after

						// Shove it through the parser function
						// updateitems() will split users, check cache, add to accumulator, etc
						updateitems(parsetweet(tweet, true), results.items);
					}
					// Yield once every iteration, to spread it out
					yield;
				}
			}
			else if (type === 'favorites') {
				for (let tweet of timeline) {
					// If max_id is given, make sure we only parse below that
					// (If it's not the first batch, there'll be a duplicate of max_id)
					if (!max_id || Filters.compareid(tweet.id_str, max_id) < 0) {
						// TODO: check for replies to fetch after

						// We don't get fav times on the timeline, so we default to
						// the tweet's created_at (which will never be later than
						// any stored favorite it's compared to in the db)
						// updateitems() will split users, check cache, add to accumulator, etc
						updateitems(
							[
								{
									type: 'favorite',
									data: {
										id_str: tweet.id_str,
										time: new Date(tweet.created_at).valueOf()
									}
								},
								...filters.on_favorite(tweet, true)
							],
							results.items
						);
					}
					// Yield once every iteration, to spread it out
					yield;
				}
			}

			// Not yet done, since there were tweets
			results.done = false;
		}

		// Update max/since in results (will insert into results if not already present)
		// We want the highest max_id
		if (!results.max_id || Filters.compareid(new_max_id, results.max_id) > 0) {
			results.max_id = new_max_id;
		}
		// We want the lowest since_id
		if (!results.since_id || Filters.compareid(new_since_id, results.since_id) < 0) {
			results.since_id = new_since_id;
		}
	}
	else {
		// No results implies no more tweets after since_id of request
		results.done = true;
	}

	return results;
}


// API access functions
function* gettimeline (results, type, since_id, max_id, count, max_requests) {
	// In case results is not yet initialized
	results = results || {};

	// Set up request params
	let params = {
		stringify_ids: true,
		user_id: appcfg.user.id_str,
	};
	params.count = (count > 0) ? count : 100;
	if (since_id) {
		params.since_id = since_id;
	}
	if (max_id) {
		params.max_id = max_id;
	}

	// Get stuff
	let timeline = yield twit.get(getpaths.timeline[type], params);

	// Parse stuff (spread out per-tick)
	results = yield iterwait(parsetimeline(results, type, timeline, max_id), 0);

	// Check if we're done, if we've hit request limit, or if we're in single-shot mode
	// (If we're seeding, we should be going back as far as possible)
	if (max_requests > 0) {
		max_requests--;
	}
	if (results.finished || !max_requests) {
		return results;
	}

	// Move down max_id to current since_id and get next batch
	return iterwait(gettimeline(results, type, since_id, results.since_id, count, max_requests), 0);
}

function* get_current_timelines () {
	const types = ['user', 'mentions', 'favorites'];

	// Fetch all timelines, parse when they arrive, wait for everything to be done
	// Get current max_ids from cache and only get results since
	let timelines = [];
	for (let type of types) {
		timelines.push(
			iterwait(
				gettimeline(
					null,
					type,
					cache.timeline[type].max_id,
					null,
					null,
					cache.limits.timeline[type]
				)
			)
		);
	}
	timelines = yield Promise.all(timelines);

	// All results in hand
	let items = [];
	for (let i = 0; i < types.length; i++) {
		let type = types[i];
		let results = timelines[i];

		// Conglomerate parsed items
		items.push(...results.items);

		// Update cached max_id if increased
		let old_max_id = cache.timeline[type].max_id;
		if (!old_max_id || Filters.compareid(results.max_id, old_max_id) > 0) {
			cache.timeline[type].max_id = results.max_id;
		}

		// Set cached since_id if not present (ie we've never fetched the timelines before)
		if (!cache.timeline[type].since_id && results.since_id) {
			cache.timeline[type].since_id = results.since_id;
		}

		// TODO: check for replies to fetch after
	}

	return items;
}

function getcursored (results, propname, getpath, params, cursor) {
	// Fresh params object, so original remains
	let p = _.assign({}, params);
	// Add cursor to params
	p.cursor = (cursor) ? cursor : -1;
	// Get, then maybe get some more
	return twit.get(getpath, p).then(data => {
		// Add results
		results.push(...data[propname]);
		// Update set once results complete
		if (data.next_cursor_str == '0') {
			return results;
		}
		// Still more to get, send next request
		return getcursored(results, propname, getpath, params, data.next_cursor_str);
	});
}

function getblocked () {
	return getcursored([], 'ids', 'blocks/ids', {stringify_ids: true}).then(
		ids => updatelist('blocked', ids),
		err => mgd.err(err)
	);
}

function getmuted () {
	return getcursored([], 'ids', 'mutes/users/ids', {stringify_ids: true}).then(
		ids => updatelist('muted', ids),
		err => mgd.err(err)
	);
}


// Stream management functions
function streamping () {
	streamretry.lastping = Date.now();
	if (streamretry.pingout) {
		clearTimeout(streamretry.pingout);
	}
	streamretry.pingout = setTimeout(() => {
		if ((Date.now() - streamretry.lastping) > streamretry.maxping) {
			twistream.destroy();
			retrystream();
		}
	}, streamretry.maxping);
}

function retrystream (response) {
	// Destroy response stream just in case it holds something open
	if (response) {
		response.destroy();
	}

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
		.on('ping', streamping)
		.on('response', res => {
			mgd.log(`[Connected: ${res.statusCode} ${res.statusMessage}]`);
			streamping();
		})
		.on('friends', fri => updatelist('following', fri.friends_str))
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
					type: 'status',
					data: {
						following: JSON.stringify(Array.from(filters.following)),
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
				type: 'status',
				data: {
					following: JSON.stringify(Array.from(filters.following)),
					time: Date.now()
				}
			});

		})
		.on('favorite', ev => {
			let tweet = ev.target_object;

			// Only match user's favorites
			if (filters.event_user_src(ev) && Filters.is_tweet(tweet)) {
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

			// Only match user's unfavorites
			if (filters.event_user_src(ev) && Filters.is_tweet(tweet)) {
				// Store unfavorite regardless
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
				// Let replies get handled by the actual tweet in the stream
				if (!filters.reply_to_user(tweet) && !filters.mentioned(tweet)) {
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
		.on('data', data => writefn(...parsetweet(data)));
}

