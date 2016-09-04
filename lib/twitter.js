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
const apilimits = {
	window: 5 * 60 * 1000,	// 5 mins
	timeline: {
		user: 20,
		mentions: 4,
		favorites: 4
	},
	statuses: {
		user: 20,
		byids: 20
	}
};
const apipaths = {
	timeline: {
		user: 'statuses/user_timeline',
		mentions: 'statuses/mentions_timeline',
		favorites: 'favorites/list'
	},
	userset: {
		following: 'friends/ids',
		blocked: 'blocks/ids',
		muted: 'mutes/users/ids'
	},
	statuses: {
		byids: 'statuses/lookup'
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
	// Kill timeouts
	iterwait.shutdown();

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
loadsets('following', 'blocked', 'muted')
.then(() => mgd.log('Loaded following, blocked, muted sets\n'))
.then(startstream)
.then(() => iterwait(refreshtimelines('user', 'mentions', 'favorites'), 0))
.catch(e => mgd.err(e));
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
function loadsets (...names) {
	// Load following, blocked, and muted lists from db
	return Promise.all(names.map(name => {
		let list = dbr.getstatus(name);
		if (list !== null) {
			filters.updateset(name, JSON.parse(list));
		}
		return get_userset(name);
	}));
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

function update_userset (name, newset) {
	if (filters.updateset(name, newset)) {
		writefn({
			type: 'log',
			data: `[${_.capitalize(name)}: ${filters[name].size}]`
		}, {
			type: 'status',
			data: {
				[name]: JSON.stringify(newset),
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
	results.replies = results.replies || new Set();

	if (timeline.length > 0) {
		// Get since/max ids
		var new_max_id = timeline[0].id_str;
		var new_since_id = timeline[timeline.length - 1].id_str;

		// Check if we've only received one tweet matching max_id (meaning no more results)
		// Compare to received since_id, as in the 1-tweet case that'll be equal to received max_id
		if (max_id && new_since_id == max_id) {
			results.complete = true;
		}
		else {
			// Iterate through and shove tweets through parser
			for (let tweet of timeline) {
				if (!tweet) {
					continue;
				}

				// Check for reply to fetch after
				let reply_id = filters.check_reply(tweet);
				if (reply_id && !cache.tweets.has(reply_id)) {
					results.replies.add(reply_id)
				}

				// If max_id is given, make sure we only parse below that
				// (If it's not the first batch, there'll be a duplicate of max_id)
				if (!max_id || Filters.compareid(tweet.id_str, max_id) < 0) {
					if (type === 'user' || type === 'mentions') {
						// Shove it through the parser function
						// updateitems() will split users, check cache, add to accumulator, etc
						updateitems(parsetweet(tweet, true), results.items);
					}
					else if (type === 'favorites') {
						// We don't get fav times on the timeline, so we default to
						// the tweet's created_at (which will never be later than
						// any stored favorite it's compared to in the db)
						// updateitems() will split users, check cache, add to accumulator, etc
						updateitems([{
							type: 'favorite',
							data: {
								id_str: tweet.id_str,
								time: new Date(tweet.created_at).valueOf()
							}
						}, ...filters.on_favorite(tweet, true)], results.items);
					}
				}
				// Yield once every iteration, to spread it out
				yield;
			}

			// Not yet done, since there were tweets
			results.complete = false;
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
		results.complete = true;
	}

	return results;
}

function* parsereplies (replyset, tweets, items) {
	items = items || [];
	for (let id of Object.keys(tweets)) {
		let tweet = tweets[id];
		replyset.delete(id);
		if (tweet) {
			// Check for reply to fetch next round
			let reply_id = filters.check_reply(tweet);
			if (reply_id && !cache.tweets.has(reply_id)) {
				replyset.add(reply_id)
			}
			// Shove through parser
			updateitems(filters.on_reply_target(tweet, true), items);
			// Yield once every iteration, to spread it out
			yield;
		}
	}
	return items;
}


// API access functions
function* gettimeline (results, type, since_id, max_id, max_requests, count) {
	// In case results is not yet initialized
	results = results || {};
	results.items = results.items || [];

	while (!results.complete && max_requests != 0 && !results.error) {
		// Set up request params
		let params = {
			stringify_ids: true,
			user_id: appcfg.user.id_str,
		};
		params.count = (count > 0) ? count : 200;
		if (since_id) {
			params.since_id = since_id;
		}
		if (max_id) {
			params.max_id = max_id;
		}

		// Get stuff
		// mgd.log(`Fetching ${type} timeline, since_id: ${since_id}, max_id: ${max_id}`);
		let timeline = yield twit.get(apipaths.timeline[type], params).catch(errfn);
		// Check error in case get() rejected
		if (results.error) {
			// Return results anyways if there's an error
			return results;
		}

		// If we have a request limit, we just used one
		if (max_requests > 0) {
			max_requests--;
		}

		// Parse stuff (spread out per-tick)
		results = yield iterwait(parsetimeline(results, type, timeline, max_id), 0).catch(errfn);

		// Move down max_id to current since_id and loop around
		max_id = results.since_id;
	}

	return results;

	// Error handler
	function errfn(e) {
		results.error = e;
		results.complete = false;
	}
}

function* getreplies (replyset) {
	let max_batches = apilimits.statuses.byids;
	let replyitems = [];
	// Check which replies we already have in cache, fetch those we don't
	while (replyset.size > 0 && max_batches > 0) {
		let tofetch = [];
		let replycount = 0;
		for (let reply_id of replyset) {
			// Check if not in cache
			if (cache.tweets.has(reply_id) || dbr.hastweet(reply_id)) {
				// Delete from set, already have
				replyset.delete(reply_id);
			}
			else {
				// Add to fetch list
				tofetch.push(reply_id);
			}

			// Yield every 100 to spread things out
			if ((++replycount % 100) === 0) {
				yield;
			}
		}

		// Fetch replies and process
		while (tofetch.length > 0 && max_batches-- > 0) {
			// Get next batch
			let ids = tofetch.splice(0, 100);
			// mgd.log(`Fetching batch of ${ids.length} replies...`);
			let tweets = yield get_tweets_by_id(ids).catch(e => {
				mgd.err(e);
				tofetch.push(...ids);
			});
			if (tweets) {
				// Parse next batch
				replyitems = yield iterwait(parsereplies(replyset, tweets, replyitems), 0);
				// Remove now-fetched from replies set
				ids.forEach(x => replyset.delete(x));
			}
		}
	}

	return replyitems;
}

function* refreshtimelines (...types) {
	// const types = ['user', 'mentions', 'favorites'];
	var reftime = Date.now();
	var complete = false;
	var results = {};
	var reply_ids = new Set();
	var cutoff = null;

	mgd.log(`Refreshing timelines ${types.join(', ')}...`);

	types.forEach(initres);

	while (!complete) {
		// Fetch all timelines, parse when they arrive, wait for everything to be done
		// Get current max_ids from cache and only get results since
		let timelines = yield Promise.all(types.map(type => {
			// Initialise results objects
			initres(type);
			// Only get results since last (cached/saved) max_id
			let since_id = cache.timeline[type].max_id;
			let max_id = results[type].since_id || null;
			// Update cache clearing cutoff for later (we want the earliest non-null previous max_id)
			cutoff = (cutoff) ? ((Filters.compareid(cutoff, since_id) > 0) ? since_id : cutoff) : since_id;
			// Max requests to make within window
			let max_requests = apilimits.timeline[type];
			// Fetch timeline, parse when it arrives, wait for everything to be done
			return iterwait(gettimeline(results[type], type, since_id, max_id, max_requests, null, 0), 0);
		}));

		// All results in hand
		let towrite = [];
		let statusupd = {};
		complete = true;
		for (let type of types) {
			let result = results[type];

			if (result.error) {
				let e = result.error;
				delete result.error;
				mgd.err(`Error refreshing timeline '${type}': ${e.message || _.toString(e)}`);
			}

			// Conglomerate parsed items
			towrite.push(...result.items);

			if (result.complete) {
				// Update cached max_id if increased
				let old_max_id = cache.timeline[type].max_id;
				if (!old_max_id || Filters.compareid(result.max_id, old_max_id) > 0) {
					cache.timeline[type].max_id = result.max_id;
				}

				// Set cached since_id if not present (ie we've never fetched the timelines before)
				if (!cache.timeline[type].since_id && result.since_id) {
					cache.timeline[type].since_id = result.since_id;
				}

				// Add status update of new id interval to item list
				statusupd[type] = {type: 'status', data: {[`timeline.${type}`]: cache.timeline[type], time: result.time}};
				// towrite.push({type: 'status', data: {[`timeline.${type}`]: cache.timeline[type], time: result.time}});

				// Remove results in case not all timelines are done (will be recreated)
				delete results[type];
			}
			else {
				// Refresh loop complete only if all types complete
				complete = false;
				// Clear intermediate results (already in queue)
				delete result.items;
			}

			// Yield each iteration to spread out
			yield;
		}

		// Fetch replies for this refresh cycle
		if (reply_ids.size > 0) {
			let replyitems = yield iterwait(getreplies(reply_ids), 0);

			// Add items to write queue
			towrite.push(...replyitems);

			// Get the rest next window if any left to fetch
			if (reply_ids.size > 0) {
				complete = false;
			}
		}

		// Log success
		mgd.log('Refreshed timelines: ' +
			((towrite.length > 0)
			? `processed ${towrite.length} item${towrite.length > 1 ? 's' : ''}`
			: 'all items up-to-date')
		);
		// Tack on status updates
		for (let type of types) {
			let upd = statusupd[type];
			if (upd) {
				towrite.push(upd);
				delete statusupd[type];
			}
		}
		// Write items
		writeitems(towrite);

		if (!complete) {
			// Run loop again in next API window
			// Timelines which are complete will refresh again
			// Those which are not can continue
			reftime += apilimits.window;
			let delaytime = reftime - Date.now();
			if (delaytime < 0) {
				delaytime = 0;
			}
			mgd.log(`Refresh incomplete, resuming at ${new Date(reftime).toLocaleTimeString()}...`);
			yield iterwait.delay(delaytime);
		}
	}

	// Schedule next refresh
	reftime += apilimits.window;
	let delaytime = reftime - Date.now();
	if (delaytime < 0) {
		delaytime = 0;
	}
	mgd.log(`Refresh complete, next refresh at ${new Date(reftime).toLocaleTimeString()}`);
	iterwait.delay(delaytime).then(() => iterwait(refreshtimelines(...types), 0));

	// While we're waiting, flush cache of tweets from before current refresh cycle
	// mgd.log(`Cache size: ${cache.tweets.size}, cutoff: ${cutoff}`);
	if (cutoff) {
		let cleared = 0;
		yield iterwait(cache.tweets.keys(), tweet_id => {
			if (Filters.compareid(tweet_id, cutoff) < 0) {
				cache.tweets.delete(tweet_id);
				cleared++;
			}
		}, 0);

		if (cleared > 0) {
			// mgd.log(`Cleared ${cleared} tweets from cache, new size: ${cache.tweets.size}`);
		}
	}

	// Initial parameters maker
	// gettimeline() will fill in the rest
	function initres (type) {
		if (!results[type]) {
			results[type] = {
				complete: false,
				replies: reply_ids,
				time: Date.now()
			};
		}
	}
}

function get_tweets_by_id (tweet_ids, map) {
	let params = {
		stringify_ids: true,
		id: tweet_ids.join(',')
	};
	if (map) {
		params.map = true;
	}
	let promise = twit.post(apipaths.statuses.byids, params);
	// If mapped, the tweets are actually nested
	if (map) {
		promise = promise.then(tweets => tweets.id);
	}
	return promise;
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

function get_userset (type) {
	return getcursored([], 'ids', apipaths.userset[type], {stringify_ids: true}).then(
		ids => update_userset(type, ids),
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
		.on('friends', fri => update_userset('following', fri.friends_str))
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

