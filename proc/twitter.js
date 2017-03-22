'use strict';

const _ = require('lodash');
const fs = require('fs');
const path = require('path');
// const ipc = require('node-ipc');
const Twitter = require('twitter');
const Filters = require('../lib/filters.js');
const Managed = require('../lib/managed.js');
const UserDB = require('../lib/db-user.js');
const iterwait = require('../lib/iterwait.js');
const rnr = require('rnr');

// Config
const user_id_str = process.env.user_id_str;

// For later reference
var filters;
var udb;

// IPC setup
const mgd = new Managed(
  {waitforgo: true},
  x => logfn('log', x),
  x => logfn('err', x)
);

// Logging setup
const log = {
  error: x => logfn('log:error', x),
  warning: x => logfn('log:warning', x),
  notify: x => logfn('log:notify', x),
  info: x => logfn('log:info', x),
  display: x => logfn('log:display', x),
  debug: x => logfn('log:debug', x),
};

process.on('unhandledRejection', (reason, p) => {
  logfn('log:error', reason);
});

// Twitter setup
const api = {
  nextrefresh: rnr.cr(function (reftime) {
    // Reset API requests remaining
    api.requests = _.cloneDeep(api.limits);
    // Set next refresh time
    let delaytime;
    do {
      reftime += api.window;
      delaytime = reftime - Date.now();
    } while (delaytime < 0);
    // Schedule delay, update after
    iterwait.delay(delaytime, reftime).then(t => this.update(t));
    // Return next refresh time
    return reftime;
  }),
  window: 15 * 60 * 1000, // 15 mins
  limits: {
    timeline: {
      user: 72,
      mentions: 12,
      favorites: 12
    },
    statuses: {
      byids: 72
    }
  },
  paths: {
    timeline: {
      user: 'statuses/user_timeline',
      mentions: 'statuses/mentions_timeline',
      favorites: 'favorites/list'
    },
    userset: {
      following: 'friends/ids',
      follower: 'followers/ids',
      blocked: 'blocks/ids',
      muted: 'mutes/users/ids'
    },
    statuses: {
      byids: 'statuses/lookup'
    }
  }
};
// Set here due to TDZ
api.requests = _.cloneDeep(api.limits);
// Refresh timelines (if not in progress) when next refresh time updated
api.lastrefresh = api.nextrefresh.on(function (reftime) {
  // Only update if last refresh cycle complete
  if (this.pending) {
    return rnr.hold;
  }
  // Otherwise, begin new refresh loop
  return iterwait(refreshtimelines('user', 'mentions', 'favorites'), 0);
});

const twit = new Twitter({
  request_options: {
    headers: {
      'User-Agent': process.env.app_name + '/' + process.env.app_version
    }
  },
  consumer_key: process.env.consumer_key,
  consumer_secret: process.env.consumer_secret,
  access_token_key: process.env.access_token_key,
  access_token_secret: process.env.access_token_secret,
});

// User, name, tweet, timeline cache
const cache = {
  users: new Map(),
  tweets: new Map(),
  timeline: null
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
  longdelay: 15 * 60 * 1000,  // 15 mins
  shutdown: false,
  timeout: null,
  lastping: null,
  maxping: 10 * 60 * 1000,  // 10 mins
  pingout: null
};

// Write queue
const writer = {
  shutdown: false,
  pending: false,
  queue: []
};

// Signal handlers
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {
  // Kill timeouts
  iterwait.shutdown();

  // Close streams
  writer.shutdown = true;
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

  log.info('Caught signal, exiting...')
  .then(() => udb.close())
  .then(() => 0)
  .catch((e) => {
    console.error(e);
    return 1;
  })
  .then((code) => {
    process.exitCode = code;
    process.disconnect();
  });
});

// Okay...GO!
iterwait((function* () {
  // Load db, construct filters
  udb = yield UserDB.open(process.env.user_db_path, { user_id: user_id_str });
  filters = new Filters(udb.config);

  // Get current timeline since/max from db config cache
  cache.timeline = _.cloneDeep(udb.config.timeline);

  // Load user sets, then start stream, then fetch current timelines
  const user_sets = ['following', 'follower', 'blocked', 'muted'];
  yield loadsets(...user_sets);
  yield log.info(`Loaded user sets ${user_sets.join(', ')}`);
  // Stream parser
  startstream();
  // Error logger
  api.lastrefresh.onerror(e => mgd.err(e));
  // Initialize so it doesn't get stuck
  api.lastrefresh.update(null, true);
  // Start refresh cycle
  api.nextrefresh.update(Date.now());
  
  // Aaaaand we're ready!
})())
.catch(e => mgd.err(e));


/* * * Functions * * */

function logfn (type, data) {
  if (data) {
    const msg = { type, data };
    // Workaround to properly serialize errors
    if (_.isError(data)) {
      msg.data = _.pick(data, ['name'].concat(Object.getOwnPropertyNames(data)));
    }
    return mgd.sendmsg(msg).catch(e => console.error(e));
  }
  return Promise.resolve();
}

function loadsets (...types) {
  // Load lists from db
  return Promise.all(types.map(name => {
    return udb.get_user_set(name)
    .then((list) => {
      if (list) {
        filters.updateset(name, list);
      }
      return get_userset(name);
    });
  }));
}

function updateitems (args, acc) {
  acc = acc || [];
  args = _.isArray(args) ? args : [args];

  for (let i = 0, len = args.length; i < len; i++) {
    let arg = args[i];

    if (_.has(arg, 'type')) {
      const { type, data } = arg;

      // // DEBUG
      // if (!type || !data) {
      //   console.log(`Empty item '${type}':`);
      //   console.dir(data, {depth: null, colors: true});
      // }

      switch(type) {
        case 'user':
          // Do nothing if user blocked
          if (!filters.is_blocked(data.user)) {
            setuser(data.user, data.time_ms);
            acc.push(arg);
          }
          break;

        case 'user_tweet':
        case 'other_tweet':
          // Do nothing if user blocked
          if (!filters.is_blocked(data.user)) {
            // Pull user out of tweet
            let [tweet, user] = updateuser(data);
            // Write user info first
            if (user) {
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
          updatetweet(data, true);
          acc.push(arg);
          break;

        default:
          acc.push(arg);
      }
    }
  }

  return acc;
}

function writeitems (args, batchsize) {
  // Add items to queue
  writer.queue.push(...args);

  if (!writer.pending) {
    writer.pending = iterwait(write_batch(batchsize > 0 ? batchsize : 1000), 0);
  }
  return writer.pending;

  function* write_batch (batch_size) {
    while (writer.queue.length > 0) {
      const changes = yield udb.write_queue(writer.queue.splice(0, batch_size));
      const counts = [];
      let total = 0;

      _.forOwn(changes, (results, type) => {
        let n = 0;
        results.forEach(([k, v]) => {
          if (_.isArray(v)) {
            const [a, r] = v;
            if (a > 0 || r > 0) {
              counts.push(`${k} (+${a}/-${r})`);
            }
            total++;
          }
          else if (!!v) {
            n++;
          }
        });

        if (n > 0) {
          total += n;
          const count = type === 'config'
            ? `${n} config ${n > 1 ? 'entries' : 'entry'}`
            : `${n} ${type}${n == 1 ? '' : type.endsWith('s') ? 'es' : 's'}`
          counts.push(count);
        }
      });

      if (total > 0) {
        log.info(`Updated ${total} items (${counts.join(', ')})`);
      }
      else {
        log.info(`All items up to date`);
      }
    }
    // No longer waiting
    writer.pending = null;
  }
}

function writefn (...args) {
  var tosend = [];

  // Peel out log items, count & queue rest
  for (const msg of args) {
    if (msg.type.startsWith('log') || msg.type.startsWith('err')) {
      logfn(msg.type, msg.data);
    }
    else {
      tosend.push(msg);
    }
  }

  // Update items as req'd
  // Then write to db
  if (tosend.length > 0) {
    return writeitems(updateitems(tosend));
  }
  return Promise.resolve();
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

function setuser (user, time_ms) {
  const data = {user, time_ms};
  // TODO: delete first for LRU semantics
  // TODO: limit cache size!
  cache.users.set(user.id_str, data);
  return data;
}

// Warning: mutates original!
function updateuser (source) {
  const [tweet, user] = Filters.splituser(source);
  let userdata;

  // Only do update check if full user object
  if (user) {
    // Use tweet's timestamp for user
    const date_u = parseInt(tweet.timestamp_ms);

    // Get currently stored user info
    const tmp = getuser(user);

    // Now compare
    if (!tmp || tmp.time_ms === undefined ||
      (date_u > tmp.time_ms && !Filters.equaluser(tmp.user, user)))
    {
      userdata = setuser(user, date_u);
    }
  }

  return [tweet, userdata];
}

function update_userset (name, newset) {
  if (filters.updateset(name, newset)) {
    log.display(`[${_.capitalize(name)}: ${filters[name].size}]`);
    writefn({
      type: 'user_set',
      data: {
        type: name,
        ids: newset,
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

    // Check if we've only received one tweet matching max_id
    // (meaning no more results)
    // Compare to received since_id, as in the 1-tweet case
    // that'll be equal to received max_id
    if (max_id && new_since_id == max_id) {
      results.complete = true;
    }
    else {
      // Iterate through and shove tweets through parser
      for (let tweet of timeline) {
        if (!tweet) {
          continue;
        }

        // Normalize for new tweet format
        tweet = Filters.normalize(tweet);

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
            updateitems(filters.parse_tweet(tweet, true), results.items);
          }
          else if (type === 'favorites') {
            // We don't get fav times on the timeline, so we default to
            // the tweet's created_at (which will never be later than
            // any stored favorite it's compared to in the db)
            // updateitems() will split users, check cache, add to accumulator, etc
            updateitems([{
              type: 'favorite',
              data: {
                tweet_id_str: tweet.id_str,
                time_ms: new Date(tweet.created_at).getTime()
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
    if (!results.max_id ||
        Filters.compareid(new_max_id, results.max_id) > 0) {
      results.max_id = new_max_id;
    }
    // We want the lowest since_id
    if (!results.since_id ||
        Filters.compareid(new_since_id, results.since_id) < 0) {
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
      // Normalize for new tweet format
      tweet = Filters.normalize(tweet);

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
function* gettimeline (results, type, since_id, max_id, count) {
  // In case results is not yet initialized
  results = results || {};
  results.items = results.items || [];

  while (!results.complete && api.requests.timeline[type] > 0 && !results.error) {
    // Set up request params
    let params = {
      user_id: user_id_str,
      tweet_mode: 'extended'
    };
    params.count = (count > 0) ? count : 200;
    if (since_id) {
      params.since_id = since_id;
    }
    if (max_id) {
      params.max_id = max_id;
    }

    // Get stuff
    let timeline;
    try {
      api.requests.timeline[type]--;
      timeline = yield twit.get(api.paths.timeline[type], params);
    }
    catch (e) {
      results.error = e;
      results.complete = false;
      return results;
    }

    // Parse stuff (spread out per-tick)
    try {
      results = yield iterwait(parsetimeline(results, type, timeline, max_id), 0);
    }
    catch (e) {
      results.error = e;
      results.complete = false;
    }

    // Move down max_id to current since_id and loop around
    max_id = results.since_id;
  }

  return results;
}

function* getreplies (replyset) {
  let replyitems = [];
  // Check which replies we already have in cache, fetch those we don't
  while (replyset.size > 0 && api.requests.statuses.byids > 0) {
    let tofetch = [];
    let replycount = 0;
    for (let reply_id of replyset) {
      // Check if not in cache
      // if (cache.tweets.has(reply_id) || udb.hastweet(reply_id)) {
      if (cache.tweets.has(reply_id)) {
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
    while (tofetch.length > 0 && api.requests.statuses.byids > 0) {
      // Get next batch
      let ids = tofetch.splice(0, 100);
      // mgd.log(`Fetching batch of ${ids.length} replies...`);
      let tweets;
      try {
        api.requests.statuses.byids--;
        tweets = yield get_tweets_by_id(ids);
      }
      catch (e) {
        mgd.err(e);
        // Push ids back onto tofetch stack
        tofetch.push(...ids);
      }

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
  var complete = false;
  var results = {};
  var reply_ids = new Set();
  var cutoff = null;

  log.info(`Refreshing timelines ${types.join(', ')}...`);

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
      // Update cache clearing cutoff for later (we want the earliest
      // non-null previous max_id)
      cutoff = (cutoff)
        ? ((Filters.compareid(cutoff, since_id) > 0) ? since_id : cutoff)
        : since_id;
      // Fetch timeline, parse when it arrives, wait for everything to be done
      return iterwait(gettimeline(results[type], type, since_id, max_id), 0);
    }));

    // All results in hand
    let towrite = [];
    let cfg = {};
    complete = true;
    for (let type of types) {
      let result = results[type];

      if (result.error) {
        let e = result.error;
        delete result.error;
        log.warning(
          `Error refreshing timeline '${type}': ${e.message || _.toString(e)}`
        );
      }

      // Conglomerate parsed items
      towrite.push(...result.items);

      if (result.complete) {
        // Update cached max_id if increased
        let old_max_id = cache.timeline[type].max_id;
        if (!old_max_id || Filters.compareid(result.max_id, old_max_id) > 0) {
          cache.timeline[type].max_id = result.max_id;
        }

        // Set cached since_id if not present (ie we've never
        // fetched the timelines before)
        if (!cache.timeline[type].since_id && result.since_id) {
          cache.timeline[type].since_id = result.since_id;
        }

        // Add status update of new id interval to item list
        cfg[type] = {
          type: 'config',
          data: {
            prefix: `timeline.${type}`,
            value: cache.timeline[type],
            time: result.time,
          }
        };

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

    // Tack on status updates
    for (let type of types) {
      let upd = cfg[type];
      if (upd) {
        towrite.push(upd);
        delete cfg[type];
      }
    }
    // Write items
    yield writeitems(towrite);

    if (!complete) {
      // Run loop again in next API window
      // Timelines which are complete will refresh again
      // Those which are not can continue
      let datestr = new Date(api.nextrefresh.value).toLocaleTimeString();
      log.info(`Refresh incomplete, resuming at ${datestr}...`);
      yield api.nextrefresh.then();
    }
  }

  // While we're waiting for writer proc to sync, flush cache of
  // tweets from previous refresh cycle
  if (cutoff) {
    let cleared = 0;
    yield iterwait(cache.tweets.keys(), tweet_id => {
      if (Filters.compareid(tweet_id, cutoff) < 0) {
        cache.tweets.delete(tweet_id);
        cleared++;
      }
    }, 0);
  }

  // Log and return completion time
  let datestr = new Date(api.nextrefresh.value).toLocaleTimeString();
  log.info(`Refresh complete, next refresh at ${datestr}`);
  return Date.now();

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
    id: tweet_ids.join(','),
    tweet_mode: 'extended'
  };
  if (map) {
    params.map = true;
  }
  let promise = twit.post(api.paths.statuses.byids, params);
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
  return getcursored([], 'ids', api.paths.userset[type], {stringify_ids: true})
  .then(
    ids => update_userset(type, ids),
    err => log.warning(err)
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

  if (!streamretry.timeout) {
    twistream.destroy();

    // Check current retries, do long delay if max retries met
    let delay;
    if (streamretry.retrynum++ >= streamretry.retries) {
      // Make fresh retry state
      streamretry.retrynum = 0;
      // Set long delay until next retry
      delay = streamretry.longdelay;
      log.warning(
        `Stream disconnected, retrying in ${Math.round(delay / 60000)}m`
      );
    }
    else {
      // Set delay until next retry
      delay = streamretry.retrydelay;
      log.warning(
        `Stream disconnected, retrying in ${Math.round(delay / 1000)}s`
      );
    }

    // Wait for delay, then attempt restarting stream
    streamretry.timeout = setTimeout(startstream, delay);
  }
}

function startstream () {
  streamretry.timeout = null;
  twistream = twit.stream('user', streamparams)
    .on('error', e => mgd.err(e))
    .on('end', retrystream)
    .on('ping', streamping)
    .on('response', (res) => {
      log.info(`[Connected: ${res.statusCode} ${res.statusMessage}]`);
      streamping();
    })
    .on('friends', (fri) => update_userset('following', fri.friends_str))
    .on('user_update', (ev) => {
      const upd = ev.source;
      log.display(`[User update: ${upd.name} (@${upd.screen_name})]`);
      writefn({
        type: 'user',
        data: {
          user: upd,
          time_ms: Date.now()
        }
      });
    })
    .on('follow', (ev) => {
      if (filters.event_user_src(ev)) {
        filters.following.add(ev.target.id_str);
        log.display(`[Followed @${ev.target.screen_name}]
[Following: ${filters.following.size}]`);
        writefn({
          type: 'user_set',
          data: {
            type:'following',
            ids: Array.from(filters.following),
            time: Date.now(),
          }
        });
      }
    })
    .on('unfollow', (ev) => {
      // Can assume user is unfollowing
      filters.following.delete(ev.target.id_str);
      log.display(`[Unfollowed @${ev.target.screen_name}]
[Following: ${filters.following.size}]`);
      writefn({
        type: 'user_set',
        data: {
          type:'following',
          ids: Array.from(filters.following),
          time: Date.now(),
        }
      });

    })
    .on('favorite', (ev) => {
      let tweet = ev.target_object;

      // Only match user's favorites
      if (filters.event_user_src(ev) && Filters.is_tweet(tweet)) {
        // Normalize for new tweet format
        tweet = Filters.normalize(tweet);

        // Store favorite regardless
        writefn({
          type: 'favorite',
          data: {
            tweet_id_str: tweet.id_str,
            time_ms: new Date(ev.created_at).getTime()
          }
        }, ...filters.on_favorite(tweet));
      }
    })
    .on('unfavorite', (ev) => {
      let tweet = ev.target_object;

      // Only match user's unfavorites
      if (filters.event_user_src(ev) && Filters.is_tweet(tweet)) {
        // Normalize for new tweet format
        tweet = Filters.normalize(tweet);

        log.display(`[Unfavorite] ${Filters.format(tweet)}`);
        // Store unfavorite regardless
        writefn({
          type: 'unfavorite',
          data: {
            tweet_id_str: tweet.id_str,
            time_ms: new Date(ev.created_at).getTime()
          }
        });
      }
    })
    .on('quoted_tweet', (ev) => {
      // Only catch others' quotes (we'll catch our own in the 'data' event)
      if (filters.event_user_tgt(ev)) {
        let tweet = ev.target_object;
        // Let replies get handled by the actual tweet in the stream
        if (!filters.reply_to_user(tweet) && !filters.mentioned(tweet)) {
          // Normalize for new tweet format
          tweet = Filters.normalize(tweet);
          writefn(...filters.on_quote(tweet));
        }
      }
    })
    .on('delete', (ev) => {
      // Handle deletes
      let del = ev.delete;
      log.display(`[Delete ${del.status.id_str}]`);
      writefn({
        type: 'delete',
        data: {
          id_str: del.status.id_str,
          time_ms: new Date(parseInt(del.timestamp_ms)).getTime()
        }
      });
    })
    .on('data', (data) => {
      let tweet = Filters.normalize(data);
      writefn(...filters.parse_tweet(tweet));
    });
}

