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

function writefn (...args) {
	let str = '';

	function append (data) {
		str += JSON.stringify(data, null, 2) + ',\n';
	}

	for (let i = 0, len = args.length; i < len; i++) {
		let arg = args[i];
		let user, tweet;

		switch(arg.type) {
			case 'log':
				logfn(arg.data);
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

	if (str.length > 0) {
		fs.appendFile(outfile, str, errfn);
	}
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
// TODO: move to Filters class
function splituser (tweet) {
	let user;
	if (_.has(tweet.user, 'name') && _.has(tweet.user, 'description')) {
		user = tweet.user;
		tweet.user = {
			id_str: user.id_str,
		};
	}
	return [user, tweet];
}

// Warning: mutates original!
function updateuser (source) {
	let [user, tweet] = splituser(source);
	let userdata;

	function comp (v1, v2, k, o1, o2) {
		// Skip missing keys, otherwise we'll get false positives
		// due to *slightly* different user objects with favs/rts
		if (v1 === undefined || v2 === undefined) {
			return true;
		}
		// Skip if both falsy - we don't need "" vs null diffs
		if (!v1 && !v2) {
			return true;
		}
		// Omit the '*_count' properties, since they'll be constantly changing
		if (_.endsWith(k, '_count')) {
			return true;
		}
		return undefined;
	};

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
			(date_u > date_t && !_.isEqualWith(tmp.user, user, comp)))
		{
			userdata = setuser(user, date_u.valueOf());
			// logfn(`[User update: ${user.name} (@${user.screen_name})]`);
		}
	}

	return [userdata, tweet];
}

function on_rt (source, silent) {
	let src_type = null, tgt_type = null, quo_type = null;
	let target = source.retweeted_status;
	let quoted;
	// Strip target from source
	source.retweeted_status = {id_str: target.id_str};

	let src_user = filters.tweetby(source);
	let tgt_user = filters.tweetof(target);
	let quo_user;

	if (filters.quote(target)) {
		quoted = target.quoted_status;
		delete target.quoted_status;
		quo_user = filters.tweetof(quoted);
	}

	if (filters.cfg[src_user].retweet[tgt_user].source) {
		src_type = src_user === 'by_user' ? 'user_tweet' : 'other_tweet';
	}
	if (filters.cfg[src_user].retweet[tgt_user].target) {
		tgt_type = tgt_user === 'of_user' ? 'user_tweet' : 'other_tweet';
	}
	if (quoted && filters.cfg[src_user].retweet[tgt_user].quoted) {
		quo_type = quo_user === 'of_user' ? 'user_tweet' : 'other_tweet';
	}

	let ret = [];
	if (!silent && (src_type !== null || tgt_type !== null || quo_type !== null)) {
		ret.push({
			type: 'log',
			data: `[RT ${source.user.screen_name}] ${formatfn(target, quoted)}`
		});
	}
	if (src_type !== null) {
		ret.push({
			type: src_type,
			data: source
		});
	}
	if (tgt_type !== null) {
		ret.push({
			type: tgt_type,
			data: target
		});
	}
	if (quo_type !== null) {
		ret.push({
			type: quo_type,
			data: quoted
		});
	}
	return ret;
}

function on_quote (source, silent) {
	let src_type = null, quo_type = null;
	let quoted = source.quoted_status;
	delete source.quoted_status;

	let src_user = filters.tweetby(source);
	let quo_user = filters.tweetof(quoted);

	if (filters.cfg[src_user].quote[quo_user].source) {
		src_type = src_user === 'by_user' ? 'user_tweet' : 'other_tweet';
	}
	if (filters.cfg[src_user].quote[quo_user].quoted) {
		quo_type = quo_user === 'of_user' ? 'user_tweet' : 'other_tweet';
	}

	let ret = [];
	if (!silent && (src_type !== null || quo_type !== null)) {
		ret.push({
			type: 'log',
			data: `[Quote] ${formatfn(source, quoted)}`
		});
	}
	if (src_type !== null) {
		ret.push({
			type: src_type,
			data: source
		});
	}
	if (quo_type !== null) {
		ret.push({
			type: quo_type,
			data: quoted
		});
	}
	return ret;
}

function on_reply (source, silent) {
	let src_type = null, quo_type = null;
	let quoted;

	// Check source, target
	let src_user = filters.tweetby(source);
	let tgt_user = filters.tweetto(source);

	if (filters.cfg[src_user].reply[tgt_user].source) {
		src_type = src_user === 'by_user' ? 'user_tweet' : 'other_tweet';
	}

	if (filters.quote(source)) {
		quoted = source.quoted_status;
		delete source.quoted_status;

		if (filters.cfg[src_user].reply[tgt_user].quoted) {
			quo_type = filters.tweetof(quoted) === 'of_user' ? 'user_tweet' : 'other_tweet';
		}
	}

	let ret = [];
	if (!silent && (src_type !== null || quo_type !== null)) {
		ret.push({
			type: 'log',
			data: `[Reply] ${formatfn(source, quoted)}`
		});
	}
	if (src_type !== null) {
		ret.push({
			type: src_type,
			data: source
		});
	}
	if (quo_type !== null) {
		ret.push({
			type: quo_type,
			data: quoted
		});
	}
	return ret;
}

function on_user_tweet (tweet, silent) {
	let ret = [];
	if (filters.cfg.by_user.standalone && filters.user(tweet.user)) {
		if (!silent) {
			ret.push({
				type: 'log',
				data: `[User] ${formatfn(tweet)}`
			});
		}
		ret.push({
			type: 'user_tweet',
			data: tweet
		});
	}
	return ret;
}

function on_mention (source, silent) {
	let src_type = null, quo_type = null;
	let quoted;

	// Check source
	let src_user = filters.tweetby(source);

	if (filters.cfg[src_user].other_mention.source) {
		src_type = src_user === 'by_user' ? 'user_tweet' : 'other_tweet';
	}

	if (filters.quote(source)) {
		quoted = source.quoted_status;
		delete source.quoted_status;

		if (filters.cfg[src_user].other_mention.quoted) {
			quo_type = filters.tweetof(quoted) === 'of_user' ? 'user_tweet' : 'other_tweet';
		}
	}

	let ret = [];
	if (!silent && (src_type !== null || quo_type !== null)) {
		ret.push({
			type: 'log',
			data: `[Mention] ${formatfn(source, quoted)}`
		});
	}
	if (src_type !== null) {
		ret.push({
			type: src_type,
			data: source
		});
	}
	if (quo_type !== null) {
		ret.push({
			type: quo_type,
			data: quoted
		});
	}
	return ret;
}

function on_favorite (source, silent) {
	let src_type = null, quo_type = null;
	let quoted;

	let src_user = filters.tweetby(source);

	if (filters.cfg[src_user].user_favorited.source) {
		src_type = src_user === 'by_user' ? 'user_tweet' : 'other_tweet';
	}

	if (filters.quote(source)) {
		quoted = source.quoted_status;
		delete source.quoted_status;

		if (filters.cfg[src_user].user_favorited.quoted) {
			quo_type = filters.tweetby(quoted) === 'by_user' ? 'user_tweet' : 'other_tweet';
		}
	}

	let ret = [];
	if (!silent && (src_type !== null || quo_type !== null)) {
		ret.push({
			type: 'log',
			data: `[Favorite] ${formatfn(source, quoted)}`
		});
	}
	if (src_type !== null) {
		ret.push({
			type: src_type,
			data: source
		});
	}
	if (quo_type !== null) {
		ret.push({
			type: quo_type,
			data: quoted
		});
	}
	return ret;
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
			}, ...on_favorite(tweet));
		}
	})
	.on('quoted_tweet', ev => {
		// Only catch others' quotes (we'll catch our own in the 'data' event)
		if (filters.event_user_tgt(ev)) {
			let tweet = ev.target_object;
			// Let replies and mentions get handled by the actual tweet in the stream
			if (!filters.reply_to_user(tweet) && !filters.mention(tweet)) {
				writefn(...on_quote(tweet));
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
					writefn(...on_rt(data));
				}
			}
			else if (filters.reply(data)) {
				writefn(...on_reply(data));
			}
			else if (filters.quote(data)) {
				writefn(...on_quote(data));
			}
			else if (filters.user(data.user)) {
				writefn(...on_user_tweet(data));
			}
			else if (filters.mention(data)) {
				writefn(...on_mention(data));
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

