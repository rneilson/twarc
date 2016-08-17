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
		this.reply_to_following = (x => _.has(x, 'in_reply_to_user_id_str') && this.following.has(x.in_reply_to_user_id_str));
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
}

module.exports = Filters;
