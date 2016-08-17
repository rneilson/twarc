'use strict';

const _ = require('lodash');
const fs = require('fs');
const ipc = require('node-ipc');
const Twitter = require('twitter');
const Filters = require('./lib/filters.js');

// Config
const appcfg = _.defaultsDeep(
	{},
	require('./cfg/user.json'),
	require('./cfg/config.json')
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
	require('./cfg/access.json'),
	require('./cfg/consumer.json')
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
var outfile = fs.openSync('./tmp/stream.json', 'w');
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

function formatfn (tweet) {
	return `${tweet.user.screen_name || '~'}: ${tweet.text}`;
}

function stripuser (tweet) {
	// Warning: mutates original
	let user = tweet.user;
	tweet.user = {
		id_str: user.id_str,
	};

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
	let tmp = userinfo.get(user.id_str);

	// Now compare
	if (tmp === undefined || !_.isEqualWith(_.omitBy(tmp, omit), _.omitBy(user, omit), comp)) {
		userinfo.set(user.id_str, user);
		writefn({
			type: 'user',
			data: user
		});
	}

	return tweet;
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
	let srctype = null;
	let tgttype = null;

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

		// Process source
		if (filter.source) {
			srctype = 'user_tweet';
		}

		// Process target
		if (filter.target) {
			tgttype = tgt_user ? 'user_tweet' : 'other_tweet';
		}

	}
	else if (filters.followed(source.user)) {
		if (filters.cfg.by_followed[type].source) {
			srctype = 'other_tweet';
		}
		if (filters.cfg.by_followed[type].target && filters.user(target.user)) {
			tgttype = 'user_tweet'
		}
	}
	else {
		if (filters.cfg.by_other[type].source) {
			srctype = 'other_tweet';
		}
		if (filters.cfg.by_other[type].target && filters.user(target.user)) {
			tgttype = 'user_tweet'
		}
	}

	// Log/send/store/whatever
	if (srctype !== null) {
		if (type === 'retweet') {
			logfn(`[RT ${source.user.screen_name}] ${formatfn(target)}`)
		}
		else if (type === 'quote') {
			logfn(`[Quote] ${formatfn(source)} [${formatfn(target)}]`);
		}
		writefn({
			type: srctype,
			data: stripuser(source)
		});
	}
	if (tgttype !== null) {
		writefn({
			type: tgttype,
			data: stripuser(target)
		});
	}
}

function on_reply (tweet) {
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

	// Pick filter setting
	let filter = filters.cfg[source].reply[target];

	// Store source
	if (filter.source) {
		logfn(`[Reply] ${formatfn(tweet)}`);
		writefn({
			type: src_user ? 'user_tweet' : 'other_tweet',
			data: stripuser(tweet)
		});
	}

	// Notify archiver of target (to check and possibly request)
	// if (filter.target && filters.reply_to_tweet(tweet)) {
	// 	writefn({
	// 		type: 'check_tweet',
	// 		data: tweet.in_reply_to_status_id_str
	// 	});
	// }

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
		_.forEach(fri.friends_str, (x => followed.add(x)));
		logfn(`[Following: ${followed.size}]`);
	})
	.on('user_update', ev => {
		let upd = ev.target_object;
		logfn(`[User update: ${upd.name} (@${upd.screen_name})]`);
		writefn({
			type: 'user',
			data: upd
		});
	})
	.on('follow', ev => {
		if (filters.event_user_src(ev)) {
			followed.add(ev.target.id_str);
			logfn(`[Followed @${ev.target.screen_name}]\n[Following: ${followed.size}]`);
		}
	})
	.on('unfollow', ev => {
		// Can assume user is unfollowing
		followed.delete(ev.target.id_str);
		logfn(`[Unfollowed @${ev.target.screen_name}]\n[Following: ${followed.size}]`);

	})
	.on('favorite', ev => {
		// Only match user's favorites
		if (filters.event_user_src(ev) && filters.tweet(ev.target_object)) {
			let tweet = ev.target_object;
			let type = null;

			if (filters.cfg.by_user.user_favorited && filters.user(tweet.user)) {
				type = 'user_tweet';
			}
			else if (filters.cfg.by_followed.user_favorited && filters.followed(tweet.user)) {
				type = 'other_tweet';
			}
			else if (filters.cfg.by_other.user_favorited) {
				type = 'other_tweet';
			}


			// Store favorite regardless
			writefn({
				type: 'favorite',
				data: {
					id_str: tweet.id_str,
					time: new Date().toISOString()
				}
			});

			// Store tweet if cfg'd
			if (type !== null) {
				logfn(`[Favorite] ${formatfn(tweet)}`);
				// Store tweet
				writefn({
					type,
					data: stripuser(tweet)
				});
			}
		}
	})
	.on('quoted_tweet', ev => {
		// Only catch others' quotes (we'll catch our own in the 'data' event)
		if (filters.event_user_tgt(ev)) {
			on_rt_or_quote(ev.target_object);
		}
	})
	.on('delete', del => {
		// Handle deletes
		// Log something to console
		logfn(`[Delete ${del.status.id_str}]`);
		// Write to file
		writefn({
			type: 'delete',
			data: {
				id_str: del.status.id_str,
				time: new Date(parseInt(del.status.timestamp_ms)).toISOString()
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

