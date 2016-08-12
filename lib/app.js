const child_process = require('child_process');
const ipc = require('node-ipc');
// const lmdb = require('node-lmdb');
// const Twitter = require('twitter');

// API keys
var apikeys = Object.assign({}, require('./cfg/.access.json'), require('./cfg/.consumer.json'));

// Launch child processes
var children = {};
// children.writer = child_process.fork('./lib/writer.js');
// children.proxy = child_process.fork('./lib/proxy.js');
// children.archiver = child_process.fork('./lib/archiver.js');
// children.websrv = child_process.fork('./lib/websrv.js');
