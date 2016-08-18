'use strict';

const _ = require('lodash');
const fs = require('fs');
const ipc = require('node-ipc');
const Twitter = require('twitter');
const Filters = require('./filters.js');

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
// TODO

// Stream params
var params = {
	with: 'user',
	stringify_friend_ids: true,
};
// Output file
var nowstr = _.replace(new Date().toISOString(), /[^0-9]/g, '').substr(0, 14);
var outfile = fs.openSync(`./tmp/stream-${nowstr}.json`, 'w');
fs.appendFileSync(outfile, '[\n');

// Signal handlers
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {
	// console.log('\nCaught signal, exiting...');
	fs.appendFileSync(outfile, ']\n');
	fs.closeSync(outfile);
	process.exit(0);
});


// Misc funcs
function logfn (...args) {
	process.send({
		type: 'log',
		data: args.join(' ')
	});
}

function errfn (err) {
	// if (err) {console.error(err);}
	if (err) {
		process.send({
			type: 'err',
			data: _.toString(err)
		})
	}
}

function writefn (data) {
	fs.appendFile(outfile, JSON.stringify(data, null, 2) + ',\n', errfn);
}

function formatfn (tweet, quote) {
	if (quote) {
		return `${formatfn(tweet)} [${formatfn(quote)}]`
	}
	return `${tweet.user.screen_name || '~'}: ${tweet.text}`;
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
function stripuser (tweet) {
	let user = tweet.user;
	tweet.user = {
		id_str: user.id_str,
	};

	// Only do update check if full user object
	// TODO: move comparison functions to filters class
	if (_.has(user, 'name') && _.has(user, 'description')) {
		let date_u;
		if (_.has(tweet, 'timestamp_ms')) {
			date_u = new Date(parseInt(tweet.timestamp_ms));
		}
		else {
			// Supply timestamp_ms if not present
			date_u = new Date(tweet.created_at)
			tweet.timestamp_ms = date_u.valueOf().toString();
		}

		// Omit the '*_count' properties, since they'll be constantly changing
		function omit (v, k) {
			return _.endsWith(k, '_count');
		};

		// Custom comparer to skip missing keys
		// Otherwise we'll get false positives due to *slightly* different user objects with favs/rts
		function comp (v1, v2, k, o1, o2) {
			if (!_.has(o1, k) || !_.has(o2, k)) {
				return true;
			}
			return _.isEqual(v1, v2);
		};

		// Get currently stored user info
		let tmp = getuser(user);
		let date_t = _.has(tmp, 'time') ? new Date(tmp.time) : undefined;

		// Now compare
		if (date_t === undefined ||
			(date_u > date_t && !_.isEqualWith(_.omitBy(tmp.user, omit), _.omitBy(user, omit), comp)))
		{

			let data = setuser(user, date_u.valueOf());
			writefn({
				type: 'user',
				data
			});
		}
	}

	return tweet;
}

function get_reply_filter (tweet) {
	let source, target;
	let src_user = false, tgt_user = false;

	// Check source
	if (filters.user(tweet.user)) {
		source = 'by_user';
		src_user = true;
	}
	else if (filters.followed(tweet.user)) {
		source = 'by_followed';
	}
	else {
		source = 'by_other';
	}

	// Check target
	if (filters.reply_to_user(tweet)) {
		target = 'to_user';
		tgt_user = true;
	}
	else if (filters.reply_to_followed(tweet)) {
		target = 'to_followed';
	}
	else {
		target = 'to_other';
	}

	// Return tweet type (or null if filtered out)
	if (filters.cfg[source].reply[target].source) {
		return src_user ? 'user_tweet' : 'other_tweet';
	}
	return null;
}

function on_rt_or_quote (source) {
	let target, type;

	if (filters.retweet(source)) {
		type = 'retweet';
		target = source.retweeted_status;
		// Strip target from source
		source.retweeted_status = {id_str: target.id_str};
	}
	else if (filters.quote(source)) {
		type = 'quote';
		target = source.quoted_status;
		// Strip target from source
		delete source.quoted_status;
	}
	// Neither, return
	else {
		return;
	}

	// Process source, target
	let src_type = null;
	let tgt_type = null;

	if (filters.user(source.user)) {
		let filter, tgt_user = false;

		if (filters.user(target.user)) {
			filter = filters.cfg.by_user[type].of_user;
			tgt_user = true;
		}
		else if (filters.followed(target.user)) {
			filter = filters.cfg.by_user[type].of_followed;
		}
		else {
			filter = filters.cfg.by_user[type].of_other;
		}

		if (filters.reply(source)) {
			// If source is a reply, use the reply logic instead
			// (Only really applicable to quotes)
			src_type = get_reply_filter(source);
		}
		else if (filter.source) {
			src_type = 'user_tweet';
		}

		if (filter.target) {
			tgt_type = tgt_user ? 'user_tweet' : 'other_tweet';
		}

	}
	else if (filters.followed(source.user)) {
		if (filters.cfg.by_followed[type].source) {
			src_type = 'other_tweet';
		}
		if (filters.cfg.by_followed[type].target && filters.user(target.user)) {
			tgt_type = 'user_tweet'
		}
	}
	else {
		if (filters.cfg.by_other[type].source) {
			src_type = 'other_tweet';
		}
		if (filters.cfg.by_other[type].target && filters.user(target.user)) {
			tgt_type = 'user_tweet'
		}
	}

	// Log/send/store/whatever
	if (src_type !== null) {
		if (type === 'retweet') {
			logfn(`[RT ${source.user.screen_name}] ${formatfn(target)}`)
		}
		else if (type === 'quote') {
			logfn(`[Quote] ${formatfn(source, target)}`);
		}
		writefn({
			type: src_type,
			data: stripuser(source)
		});
	}
	if (tgt_type !== null) {
		writefn({
			type: tgt_type,
			data: stripuser(target)
		});
	}
}

function on_reply (tweet) {
	let src_type = get_reply_filter(tweet);

	// Store source
	if (src_type !== null) {
		logfn(`[Reply] ${formatfn(tweet)}`);
		writefn({
			type: src_type,
			data: stripuser(tweet)
		});
	}

}

function on_user_tweet (tweet) {
	if (filters.cfg.by_user.standalone && filters.user(tweet.user)) {
		logfn(`[User] ${formatfn(tweet)}`);
		writefn({
			type: 'user_tweet',
			data: stripuser(tweet)
		});
	}
}

function on_mention (tweet) {
	if (!filters.user(tweet.user)) {
		let src = false;
		if (filters.cfg.by_followed.other_mention.source && filters.followed(tweet.user)) {
			src = true;
		}
		else if (filters.cfg.by_other.other_mention.source) {
			src = true;
		}

		if (src) {
			logfn(`[Mention] ${formatfn(tweet)}`);
			writefn({
				type: 'other_tweet',
				data: stripuser(tweet)
			});
		}
	}
}

function on_favorite (source) {
	let target = null, src_type = null, tgt_type = null;
	let src_user = filters.tweetby(source);

	if (filters.cfg[src_user].user_favorited.source) {
		src_type = src_user === 'by_user' ? 'user_tweet' : 'other_tweet';
	}

	if (filters.quote(source)) {
		target = source.quoted_status;
		delete source.quoted_status;

		if (filters.cfg[src_user].user_favorited.target) {
			tgt_type = filters.tweetby(target) === 'by_user' ? 'user_tweet' : 'other_tweet';
		}
	}

	// Store tweet if cfg'd
	if (src_type !== null) {
		if (tgt_type === null) {
			logfn(`[Favorite] ${formatfn(source)}`);
			// Store tweet
			writefn({
				src_type,
				data: stripuser(source)
			});
		}
		else {
			logfn(`[Favorite] ${formatfn(source, target)}`);
			// Store tweets
			writefn({
				src_type,
				data: stripuser(source)
			});
		}
	}
	// Store quoted tweet if applicable
	if (tgt_type !== null) {
		writefn({
			type: tgt_type,
			data: stripuser(target)
		});
	}
}


// Okay...GO!
process.send('heartbeat');
setInterval(process.send.bind(process, 'heartbeat'), 2000);
// TODO: move to Managed class, set HB interval in cfg

// Start stream
var twistream = twit.stream('user', params)
	.on('error', err => {
		console.error(err);
	})
	.on('friends', fri => {
		// Add id to followed set
		_.forEach(fri.friends_str, (x => filters.following.add(x)));
		logfn(`[Following: ${filters.following.size}]`);
	})
	.on('user_update', ev => {
		let upd = ev.target_object;
		let data = setuser(upd, Date.now());
		logfn(`[User update: ${upd.name} (@${upd.screen_name})]`);
		writefn({
			type: 'user',
			data
		});
	})
	.on('follow', ev => {
		if (filters.event_user_src(ev)) {
			filters.following.add(ev.target.id_str);
			logfn(`[Followed @${ev.target.screen_name}]\n[Following: ${filters.following.size}]`);
		}
	})
	.on('unfollow', ev => {
		// Can assume user is unfollowing
		filters.following.delete(ev.target.id_str);
		logfn(`[Unfollowed @${ev.target.screen_name}]\n[Following: ${filters.following.size}]`);

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
			});

			// Store tweet if cfg'd
			on_favorite(tweet);
		}
	})
	.on('quoted_tweet', ev => {
		// Only catch others' quotes (we'll catch our own in the 'data' event)
		if (filters.event_user_tgt(ev)) {
			on_rt_or_quote(ev.target_object);
		}
	})
	.on('delete', ev => {
		// Handle deletes
		let del = ev.delete;
		// Log something to console
		logfn(`[Delete ${del.status.id_str}]`);
		// Write to file
		writefn({
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
			if (filters.retweet(data) || filters.quote(data)) {
				on_rt_or_quote(data);
			}
			else if (filters.reply(data)) {
				on_reply(data);
			}
			else if (filters.user(data.user)) {
				on_user_tweet(data);
			}
			else if (filters.mention(data)) {
				on_mention(data);
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

