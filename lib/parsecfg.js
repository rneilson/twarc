'use strict';

const _ = require('lodash');

module.exports = {
  decompose,
  recombine,
};

function recombine (entries, prefix, accumulator) {
  // No prefix means empty string, so we don't get keys starting with '.'
  const pre = prefix ? prefix + '.' : false;

  return _.reduce(
    entries,
    (acc, ent) => {
      let key, value;
      if (_.isArray(ent)) {
        [ key, value ] = ent;
      }
      else if (_.isObject(ent)) {
        ({ key, value } = ent);
      }
      return key && (!pre || key.startsWith(pre))
        ? _.set(acc, pre ? key.substr(pre.length) : key, value)
        : key && key === prefix
          ? value
          : acc;
    },
    accumulator || {}
  );
}

function decompose (value, prefix, accumulator) {
  const acc = accumulator || [];

  // Recurse with new prefix if value is object
  if (_.isObjectLike(value) && !_.isArray(value)) {
    // No prefix means empty string, so we don't get keys starting with '.'
    const pre = prefix ? prefix + '.' : '';
    _.forOwn(value, (v, k) => decompose(v, pre + k, acc));
  }
  // Otherwise, stringify and push already-prefixed key to result array
  else {
    acc.push([prefix, value]);
  }
  return acc;
}
