#!/usr/bin/env node
use strict;

const path = require('path');
// TODO: move to manager.js
const child_process = require('child_process');

// Not-yet-used modules
// const ipc = require('node-ipc');
// const lmdb = require('node-lmdb');
// const Twitter = require('twitter');
// const Manager = require('./manager.js');

// Change to base directory for consistency
process.chdir(path.join(__dirname, '..'));

// API keys
var apikeys = Object.assign({}, require('./cfg/consumer.json'), require('./cfg/access.json'));

// Config
var appconfig = Object.assign({}, require('./cfg/config.json'), apikeys);

// Launch child processes
var children = {};
// var childenv = Object.assign({}, process.env, appconfig);
var childnames = [];
// var childnames = ['writer', 'proxy', 'archiver', 'websrv'];

/* Child process init */



/* FUNCTIONS */

// TODO: move to manager.js
function launchproc (procfile, ...args) {
	// Default options
	const defaults = {
		waitformsg: false,
		relaunch: false,
		forkopts: null,
		addtoenv: null,
	};
	// Options to use
	var useopts = Object.assign({}, defaults);
	// Child args to use
	var useargs = [];
	// Process name (default to file/module)
	var usename = procfile;

	// Parse options
	for (let i = 0, len_i = args.length; i < len_i; i++) {
		let opt = args[i];
		// String args will overwrite child name
		if (typeof opt === 'string') {
			usename = opt;
		}
		// Array args will extend defaults
		else if (Array.isArray(opt)) {
			useargs = useargs.concat(opt);
		}
		// Object args will overwrite defaults
		else if (typeof opt === 'object') {
			useopts = Object.assign(useopts, opt);
		}
		// TODO: add function check for callbacks
	}

	// Process environment values
	var useenv = Object.assign({}, useopts.forkopts.env || process.env);
	// Update fork options
	if (typeof useopts.forkopts === 'object') {
		useopts.forkopts.env = useenv;
	}
	else {
		useopts.forkopts = { env: useenv };
	}
	// Add extra environment values
	if (typeof useopts.addtoenv === 'object'){
		useenv = Object.assign(useenv, useopts.addtoenv)
	}

	// Launch process
	var child = child_process.fork(procfile, useargs, useopts.forkopts);

	// TODO: attach exit handler for relaunch

	// Return promise
	if (useopts.waitformsg) {
		return new Promise((resolve, reject) => {
			let errfn = (err => {
				reject(err);
			});
			// Reject promise if error occurs during spawn
			child.once('error', errfn);
			// Resolve promise once child sends first message
			child.once('message', () => {
				// Remove error handler
				child.removeListener('error', errfn);
				children[usename] = child;
				resolve(child);
			});
		});
	}
	else {
		children[usename] = child;
		return Promise.resolve(child);
	}
}

