'use strict';

const _ = require('lodash');

class Filters {

	constructor ({ filters, user }) {
		this.cfg = filters;

		// Filter sets
		this.following = new Set();
		this.follower = new Set();
		this.blocked = new Set();
		this.muted = new Set();

		// Filter functions
		this.user = _.matchesProperty('id_str', user.id_str);
		this.followed = (x =>
			_.has(x, 'id_str') &&
			this.following.has(x.id_str)
		);
		this.mentioned = (x =>
			_.has(x, 'entities.user_mentions') &&
			_.some(x.entities.user_mentions, this.user)
		);
		this.reply_to_user = _.matchesProperty(
			'in_reply_to_user_id_str',
			user.id_str
		);
		this.reply_to_followed = (x =>
			_.has(x, 'in_reply_to_user_id_str') &&
			this.following.has(x.in_reply_to_user_id_str)
		);
		this.event_user_src = _.matchesProperty('source.id_str', user.id_str);
		this.event_user_tgt = _.matchesProperty('target.id_str', user.id_str);
	}

	static is_tweet (obj) {
		return (
			(_.has(obj, 'id_str') && _.isString(obj.id_str)) &&
			((_.has(obj, 'text') && _.isString(obj.text)) ||
			 (_.has(obj, 'full_text') && _.isString(obj.full_text)))
		);
	}

	static is_retweet (obj) {
		return (
			_.has(obj, 'retweeted_status') &&
			_.isObjectLike(obj.retweeted_status)
		);
	}

	static is_quote (obj) {
		return (
			_.has(obj, 'quoted_status') &&
			_.isObjectLike(obj.quoted_status)
		);
	}

	static is_quote_of_tweet (obj) {
		return (
			(_.has(obj, 'is_quote_status') && obj.is_quote_status === true) &&
			(_.has(obj, 'quoted_status_id_str') && _.isString(obj.quoted_status_id_str))
		);
	}

	static is_reply (obj) {
		return (
			_.has(obj, 'in_reply_to_user_id_str') &&
			_.isString(obj.in_reply_to_user_id_str)
		);
	}

	static is_reply_to_tweet (obj) {
		return (
			_.has(obj, 'in_reply_to_status_id_str') &&
			_.isString(obj.in_reply_to_status_id_str)
		);
	}

	static is_event (obj) {
		return (_.has(obj, 'event') && _.isString(obj.event));
	}

	static is_delete (obj) {
		return (_.has(obj, 'delete') && _.isObjectLike(obj.delete));
	}

	static compareid (ida, idb) {
		// Falsy checks
		if (!ida) {
			return (!idb) ? 0 : -1;
		}
		else if (!idb) {
			return 1;
		}
		// Unlike normal string sorting, longer means higher by definition
		if (ida.length > idb.length) {
			return 1;
		}
		else if (ida.length < idb.length) {
			return -1;
		}
		else {
			// Equal length, compare char-by-char
			for (let i = 0; i < ida.length; i++) {
				let a = ida[i], b = idb[i];
				if (a > b) {
					return 1;
				}
				else if (a < b) {
					return -1;
				}
				// Chars equal, continue
			}
			// Strings equal
			return 0;
		}
	}

	static normalize (tweet) {
		function fix (obj) {
			// Pull extended tweet properties into main tweet
			if (_.has(obj, 'extended_tweet')) {
				Object.assign(obj, obj.extended_tweet);
				delete obj.extended_tweet;
				obj.truncated = false;
			}

			// Rename 'full_text' to 'text' if former present
			if (_.has(obj, 'full_text')) {
				obj.text = obj.full_text;
				delete obj.full_text;
			}
			
			// Fix missing timestamps
			if (!_.has(obj, 'timestamp_ms') &&
					_.has(obj, 'created_at')) {
				obj.timestamp_ms = String(new Date(obj.created_at).getTime());
			}

			// Recurse into retweets & quotes
			if (_.has(obj, 'retweeted_status')) {
				fix(obj.retweeted_status);
			}
			if (_.has(obj, 'quoted_status')) {
				fix(obj.quoted_status);
			}

			return obj;
		}

		return fix(tweet);
	}

	static stub (tweet) {
		return {
			id_str: tweet.id_str,
			user: {
				id_str: tweet.user.id_str
			}
		};
	}

	static format (tweet, quote) {
		if (quote) {
			return `${this.format(tweet)} [${this.format(quote)}]`;
		}
		return `${tweet.user.screen_name || '~'}: ${_.unescape(tweet.text)}`;
	}

	// Warning: mutates original!
	static splituser (tweet) {
		let user;
		if (_.has(tweet.user, 'screen_name')) {
			user = tweet.user;
			tweet.user = {
				id_str: user.id_str,
			};
		}
		return [tweet, user];
	}

	static equaluser (olduser, newuser) {
		function comp (vold, vnew, key) {
			// Skip missing keys in either object
			if (vold === undefined || vnew === undefined) {
				return true;
			}
			// Skip the id key, 'cause JS numbers etc
			else if (key == 'id') {
				return true;
			}
			// Skip the *_count keys (or else we'll update users every time they tweet/fav)
			else if (_.endsWith(key, '_count')) {
				return true;
			}
			// Skip if both falsy -- we don't need "" vs null diffs
			else if (!vold && !vnew) {
				return true;
			}
			// Array comp
			else if (_.isArray(vold) && _.isArray(vnew)) {
				// Different lengths -> unequal
				if (vold.length !== vnew.length) {
					return false;
				}
				// Recurse per item (all must match)
				return _.every(vold, (v, i) => comp(v, vnew[i], i));
			}
			// Object comp
			else if (_.isObjectLike(vold) && _.isObjectLike(vnew)) {
				const kold = Object.keys(vold);
				// More keys in new object -> unequal
				if (Object.keys(vnew).length > kold.length) {
					return false;
				}
				// Recurse per old-object key
				return _.every(kold, (k) => comp(vold[k], vnew[k], k));
			}
			// Everything else, *not* strict equality comp
			else if (vold == vnew) {
				return true;
			}
			return false;
		};

		return comp(olduser, newuser);
	}

	tweetby (tweet) {
		if (this.user(tweet.user)) {
			return 'by_user';
		}
		else if (this.followed(tweet.user)) {
			return 'by_followed';
		}
		return 'by_other';
	}

	tweetof (tweet) {
		if (this.user(tweet.user)) {
			return 'of_user';
		}
		else if (this.followed(tweet.user)) {
			return 'of_followed';
		}
		return 'of_other';
	}

	tweetto (tweet) {
		if (this.reply_to_user(tweet)) {
			return 'to_user';
		}
		else if (this.reply_to_followed(tweet)) {
			return 'to_followed';
		}
		return 'to_other';
	}

	is_blocked (user) {
		return this.blocked.has(user.id_str);
	}

	is_muted (user) {
		return this.muted.has(user.id_str);
	}

	updateset (name, newdata) {
		let update = false;
		let oldset = this[name];
		let newset;

		// Check size first
		if (oldset.size !== _.get(newdata, 'size', _.get(newdata, 'length', 0))) {
			// Build replacement set, skip cross-check
			newset = new Set(newdata);
			update = true;
		}
		else {
			// Build new set
			newset = new Set();

			// Check for new ids and build new set
			for (let item of newdata) {
				// Add to new set (for reverse check and/or set replacement)
				newset.add(item);

				// Check if not in old set
				if (!oldset.has(item)) {
					update = true;
				}
			}

			// Reverse check (ids removed since last update)
			if (!update) {
				for (let item of oldset) {
					if (!newset.has(item)) {
						update = true;
						// Now we can break right away, since we've built our new set already
						break;
					}
				}
			}
		}

		if (update) {
			// Update set
			this[name] = newset;
		}

		return update;
	}

	parse_tweet (data, silent) {
		var ret = [];

		// Handle tweets
		if (this.constructor.is_tweet(data)) {
			// Pass to appropriate func
			if (this.constructor.is_retweet(data)) {
				if (this.user(data.user) || this.mentioned(data)) {
					ret.push(...this.on_rt(data, silent));
				}
			}
			else if (this.constructor.is_reply(data)) {
				ret.push(...this.on_reply(data, silent));
			}
			else if (this.constructor.is_quote(data)) {
				ret.push(...this.on_quote(data, silent));
			}
			else if (this.user(data.user)) {
				ret.push(...this.on_user_tweet(data, silent));
			}
			else if (this.mentioned(data)) {
				ret.push(...this.on_mention(data, silent));
			}
		}

		return ret;
	}

	on_rt (source, silent) {
		let src_type = null, tgt_type = null, quo_type = null;
		let target = source.retweeted_status;
		let quoted;
		// Strip target from source
		source.retweeted_status = this.constructor.stub(target);

		let src_user = this.tweetby(source);
		let tgt_user = this.tweetof(target);
		let quo_user;

		if (this.constructor.is_quote(target)) {
			quoted = target.quoted_status;
			target.quoted_status = this.constructor.stub(quoted);
			quo_user = this.tweetof(quoted);
		}

		// Stub quoted from source if present
		if (this.constructor.is_quote(source)) {
			source.quoted_status = this.constructor.stub(source.quoted_status);
		}
		// But add stub if not present in source
		else if (this.constructor.is_quote_of_tweet(source)) {
			if (quoted && source.quoted_status_id_str == quoted.id_str) {
				source.quoted_status = this.constructor.stub(quoted);
			}
		}

		if (this.cfg[src_user].retweet[tgt_user].source) {
			src_type = src_user === 'by_user' ? 'user_tweet' : 'other_tweet';
		}
		if (this.cfg[src_user].retweet[tgt_user].target) {
			tgt_type = tgt_user === 'of_user' ? 'user_tweet' : 'other_tweet';
		}
		if (quoted && this.cfg[src_user].retweet[tgt_user].quoted) {
			quo_type = quo_user === 'of_user' ? 'user_tweet' : 'other_tweet';
		}

		let ret = [];
		if (!silent && (src_type !== null || tgt_type !== null || quo_type !== null)) {
			let text = this.constructor.format(target, quoted);
			ret.push({
				type: 'log:display',
				data: `[RT ${source.user.screen_name}] ${text}`
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

	on_quote (source, silent) {
		let src_type = null, quo_type = null;
		let quoted = source.quoted_status;
		source.quoted_status = this.constructor.stub(quoted);

		let src_user = this.tweetby(source);
		let quo_user = this.tweetof(quoted);

		if (this.cfg[src_user].quote[quo_user].source) {
			src_type = src_user === 'by_user' ? 'user_tweet' : 'other_tweet';
		}
		if (this.cfg[src_user].quote[quo_user].quoted) {
			quo_type = quo_user === 'of_user' ? 'user_tweet' : 'other_tweet';
		}

		let ret = [];
		if (!silent && (src_type !== null || quo_type !== null)) {
			ret.push({
				type: 'log:display',
				data: `[Quote] ${this.constructor.format(source, quoted)}`
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

	on_reply (source, silent) {
		let src_type = null, quo_type = null;
		let quoted;

		// Check source, target
		let src_user = this.tweetby(source);
		let tgt_user = this.tweetto(source);

		if (this.cfg[src_user].reply[tgt_user].source) {
			src_type = src_user === 'by_user' ? 'user_tweet' : 'other_tweet';
		}

		if (this.constructor.is_quote(source)) {
			quoted = source.quoted_status;
			source.quoted_status = this.constructor.stub(quoted);

			if (this.cfg[src_user].reply[tgt_user].quoted) {
				quo_type = this.tweetof(quoted) === 'of_user'
					? 'user_tweet'
					: 'other_tweet';
			}
		}

		let ret = [];
		if (!silent && (src_type !== null || quo_type !== null)) {
			ret.push({
				type: 'log:display',
				data: `[Reply] ${this.constructor.format(source, quoted)}`
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

	on_reply_target (target, silent) {
		let tgt_type = null, quo_type = null;
		let quoted;

		// Check target
		tgt_type = this.tweetby(target) === 'by_user'
			? 'user_tweet'
			: 'other_tweet';

		if (this.constructor.is_quote(target)) {
			quoted = target.quoted_status;
			target.quoted_status = this.constructor.stub(quoted);

			quo_type = this.tweetof(quoted) === 'of_user'
				? 'user_tweet'
				: 'other_tweet';
		}

		let ret = [];
		if (!silent && (tgt_type !== null || quo_type !== null)) {
			ret.push({
				type: 'log:display',
				data: `[Reply] ${this.constructor.format(target, quoted)}`
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

	on_user_tweet (tweet, silent) {
		let ret = [];
		if (this.cfg.by_user.standalone && this.user(tweet.user)) {
			if (!silent) {
				ret.push({
					type: 'log:display',
					data: `[User] ${this.constructor.format(tweet)}`
				});
			}
			ret.push({
				type: 'user_tweet',
				data: tweet
			});
		}
		return ret;
	}

	on_mention (source, silent) {
		let src_type = null, quo_type = null;
		let quoted;

		// Check source
		let src_user = this.tweetby(source);

		if (this.cfg[src_user].other_mention.source) {
			src_type = src_user === 'by_user' ? 'user_tweet' : 'other_tweet';
		}

		if (this.constructor.is_quote(source)) {
			quoted = source.quoted_status;
			source.quoted_status = this.constructor.stub(quoted);

			if (this.cfg[src_user].other_mention.quoted) {
				quo_type = this.tweetof(quoted) === 'of_user'
					? 'user_tweet'
					: 'other_tweet';
			}
		}

		let ret = [];
		if (!silent && (src_type !== null || quo_type !== null)) {
			ret.push({
				type: 'log:display',
				data: `[Mention] ${this.constructor.format(source, quoted)}`
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

	on_favorite (source, silent) {
		let src_type = null, quo_type = null;
		let quoted;

		let src_user = this.tweetby(source);

		if (this.cfg[src_user].user_favorited.source) {
			src_type = src_user === 'by_user' ? 'user_tweet' : 'other_tweet';
		}

		if (this.constructor.is_quote(source)) {
			quoted = source.quoted_status;
			source.quoted_status = this.constructor.stub(quoted);

			if (this.cfg[src_user].user_favorited.quoted) {
				quo_type = this.tweetby(quoted) === 'by_user'
					? 'user_tweet'
					: 'other_tweet';
			}
		}

		let ret = [];
		if (!silent && (src_type !== null || quo_type !== null)) {
			ret.push({
				type: 'log:display',
				data: `[Favorite] ${this.constructor.format(source, quoted)}`
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

	check_reply (tweet) {
		// Check source, target
		let src_user = this.tweetby(tweet);
		let tgt_user = this.tweetto(tweet);

		if (this.constructor.is_reply_to_tweet(tweet) &&
			this.cfg[src_user].reply[tgt_user].target) {
			return tweet.in_reply_to_status_id_str;
		}
		// Otherwise return undefined
	}

}

module.exports = Filters;
