#!/usr/bin/env node
'use strict';

const path = require('path');

// Not-yet-used modules
// const ipc = require('node-ipc');
// const lmdb = require('node-lmdb');
// const Twitter = require('twitter');
const Manager = require('./manager.js');

// Change to base directory for consistency
process.chdir(path.join(__dirname, '..'));

// API keys
const apikeys = Object.assign({}, require('./cfg/consumer.json'), require('./cfg/access.json'));

// Config
const appconfig = Object.assign({}, require('./cfg/config.json'), apikeys);

const mgr = new Manager();

// Launch child processes
const childnames = [];
// var childnames = ['writer', 'proxy', 'archiver', 'websrv'];



