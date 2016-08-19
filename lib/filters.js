'use strict';

const _ = require('lodash');

class Filters {

	constructor (cfg) {
		this.cfg = cfg.filters;
		this.following = new Set();
		this.true = (x => x === true);
		this.false = (x => x === false);
		this.user = _.matchesProperty('id_str', cfg.user.id_str);
		this.followed = (x => _.has(x, 'id_str') && this.following.has(x.id_str));
		this.tweet = _.conforms({
				id_str: _.isString,
				text: _.isString
			});
		this.retweet = _.conforms({
				retweeted_status: _.isObjectLike
			});
		this.quote = _.conforms({
				is_quote_status: this.true,
				quoted_status_id_str: _.isString,
				quoted_status: _.isObjectLike
			});
		this.reply = _.conforms({
				in_reply_to_user_id_str: _.isString
			});
		this.reply_to_tweet = _.conforms({
				in_reply_to_status_id_str: _.isString
			});
		this.reply_to_user = _.matchesProperty('in_reply_to_user_id_str', cfg.user.id_str);
		this.reply_to_followed = (x => _.has(x, 'in_reply_to_user_id_str') && this.following.has(x.in_reply_to_user_id_str));
		this.event = _.conforms({
				event: _.isString
			});
		this.event_user_src = _.matchesProperty('source.id_str', cfg.user.id_str);
		this.event_user_tgt = _.matchesProperty('target.id_str', cfg.user.id_str);
		this.delete = _.conforms({
				'delete': _.isObjectLike
			});
		this.mention = (x => _.has(x, 'entities.user_mentions') && _.some(x.entities.user_mentions, this.user));
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

	format (tweet, quote) {
		if (quote) {
			return `${this.format(tweet)} [${this.format(quote)}]`
		}
		return `${tweet.user.screen_name || '~'}: ${tweet.text}`;
	}

	// Warning: mutates original!
	splituser (tweet) {
		let user;
		if (_.has(tweet.user, 'name') && _.has(tweet.user, 'description')) {
			user = tweet.user;
			tweet.user = {
				id_str: user.id_str,
			};
		}
		return [user, tweet];
	}

	on_rt (source, silent) {
		let src_type = null, tgt_type = null, quo_type = null;
		let target = source.retweeted_status;
		let quoted;
		// Strip target from source
		source.retweeted_status = {id_str: target.id_str};

		let src_user = this.tweetby(source);
		let tgt_user = this.tweetof(target);
		let quo_user;

		if (this.quote(target)) {
			quoted = target.quoted_status;
			delete target.quoted_status;
			quo_user = this.tweetof(quoted);
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
			ret.push({
				type: 'log',
				data: `[RT ${source.user.screen_name}] ${this.format(target, quoted)}`
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
		delete source.quoted_status;

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
				type: 'log',
				data: `[Quote] ${this.format(source, quoted)}`
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

		if (this.quote(source)) {
			quoted = source.quoted_status;
			delete source.quoted_status;

			if (this.cfg[src_user].reply[tgt_user].quoted) {
				quo_type = this.tweetof(quoted) === 'of_user' ? 'user_tweet' : 'other_tweet';
			}
		}

		let ret = [];
		if (!silent && (src_type !== null || quo_type !== null)) {
			ret.push({
				type: 'log',
				data: `[Reply] ${this.format(source, quoted)}`
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

	on_user_tweet (tweet, silent) {
		let ret = [];
		if (this.cfg.by_user.standalone && this.user(tweet.user)) {
			if (!silent) {
				ret.push({
					type: 'log',
					data: `[User] ${this.format(tweet)}`
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

		if (this.quote(source)) {
			quoted = source.quoted_status;
			delete source.quoted_status;

			if (this.cfg[src_user].other_mention.quoted) {
				quo_type = this.tweetof(quoted) === 'of_user' ? 'user_tweet' : 'other_tweet';
			}
		}

		let ret = [];
		if (!silent && (src_type !== null || quo_type !== null)) {
			ret.push({
				type: 'log',
				data: `[Mention] ${this.format(source, quoted)}`
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

		if (this.quote(source)) {
			quoted = source.quoted_status;
			delete source.quoted_status;

			if (this.cfg[src_user].user_favorited.quoted) {
				quo_type = this.tweetby(quoted) === 'by_user' ? 'user_tweet' : 'other_tweet';
			}
		}

		let ret = [];
		if (!silent && (src_type !== null || quo_type !== null)) {
			ret.push({
				type: 'log',
				data: `[Favorite] ${this.format(source, quoted)}`
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


}

module.exports = Filters;
