#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const _ = require('lodash');
const iterwait = require('../lib/iterwait');
const Manager = require('../lib/manager');
const MasterDB = require('../lib/db-master');
const pkg = require('../package.json');

// Change to base directory for consistency
const base_path = path.resolve(path.join(__dirname, '..'));
process.chdir(base_path);

function datestr (d) {
	return (d ? new Date(d) : new Date()).toISOString().replace(/[^0-9]/g, '');
}

function errcb (err) {
	if (err) {
		if (_.isError(err)) {
			err = _.toString(err.stack);
		}
		console.error('[ERROR]', err);
	}
}

const stack_types = new Set(['error', 'warning']);

// Kick off
iterwait((function* () {
	// TODO: accept alternate path as cmdline arg
	// TODO: check list of well-known locations
	const db_path = path.join(base_path, './data/db/master.db');

	// Load master db
	const mdb = yield MasterDB.open(db_path);

	// Open log file
	const log_file = yield new Promise((resolve, reject) => {
		const log_path = path.resolve(mdb.config.dir.log, `master-${datestr()}.log`);
		fs.open(log_path, 'a', (err, fd) => err ? reject(err) : resolve(fd));
	});

	// Logging functions
	function logger (level, proc, message) {
		const log_level = _.isObject(level) ? level : mdb.log_type.get(level);
		const is_err = stack_types.has(log_level.label);
		const use_stack = is_err && _.get(mdb.config, 'log.error.use_stack');
		const msg_text = (msg) => {
			if (is_err) {
				if (use_stack && _.has(msg, 'stack')) {
					return msg.stack;
				}
				if (_.has(msg, 'message')) {
					return msg.message;
				}
			}
			if (_.isObject(msg)) {
				return JSON.stringify(msg);
			}
			return String(msg);
		};

		const time = _.has(message, 'time') ? new Date(message.time) : new Date();
		const proc_name = _.has(proc, 'name') ? proc.name : (proc || null);
		const proc_text = `[${_.upperFirst(proc_name || 'Unknown')}] `;
		const text = msg_text(message);

		if (log_level.to_db) {
			mdb.write_log(
				text,
				{
					proc_name: (proc && proc.name) || null,
					user_id: (proc && proc.user_id_str) || null,
					time: time.getTime(),
					type: log_level.label
				}
			)
			.catch(errcb);
		}
		
		if (log_level.to_file) {
			// Add timestamp
			let msg = `${time.toISOString()} ${proc_text}`;

			// Add extra leading spaces due to prefix
			msg += text.split('\n').join('\n' + ' '.repeat(msg.length));

			fs.appendFile(log_file, msg + '\n', errcb);
		}

		if (log_level.to_console) {
			console[is_err ? 'error' : 'log'](
				proc_text + text.split('\n').join('\n' + ' '.repeat(proc_text.length))
			);
		}
	}

	const default_log_level = mdb.log_type.get(mdb.config.log.default_type);
	const default_err_level = mdb.log_type.get(mdb.config.log.error.default_type);
	const manager_log_level = mdb.log_type.get('notify') || default_log_level;

	// Create process manager
	const mgr = new Manager({
			waitformsg: true,
			relaunch: true,
			relaunchtime: 1000
		},
		(msg, level) => {
			const log_level = level
				? _.isObject(level) ? level : mdb.log_type.get(level)
				: manager_log_level;
			logger(log_level, {name: 'Master'}, msg);
		},
		(msg, level) => {
			const log_level = level
				? _.isObject(level) ? level : mdb.log_type.get(level)
				: default_err_level;
			logger(log_level, {name: 'ERROR'}, msg);
		}
	);

	// Add log level handlers
	for (const [label, level] of mdb.log_type.entries()) {
		if (_.isString(label)) {
			mgr.on(`log:${label}`, _.partial(logger, level));
		}
	}

	// Add default child log/err handlers
	mgr.on('log', _.partial(logger, default_log_level));
	mgr.on('err', _.partial(logger, default_err_level));

	// Add signal handler
	function sigfn () {
		console.log('');
		mgr.log('Caught signal, exiting...');

		// Shut down all running processes
		// Wait for all processes to exit or timeout before continuing
		Promise.all(mgr.shutdown().map(x => x.catch(e => e)))
		.then((procs) => {
			process.exitCode = 0;
			mgr.log('Shutting down master...');
			return mdb.close();
		})
		.catch((err) => {
			if (_.isError(err)) {
				err = _.toString(err.stack);
			}
			mgr.err(`Error during shutdown: ${err}`);
			process.exitCode = 1;
		});
	};
	process.on('SIGINT', sigfn);
	process.on('SIGTERM', sigfn);

	mgr.log(`Started: master, PID: ${process.pid}`);

	// Add child relaunch handlers
	mgr.on('restart', (procname, promise) => mgr.log(`Restarting '${procname}'`));

	// Get list of active users to launch processes for
	const to_launch = yield mdb.user_data({ is_active: true });

	// const childnames = ['twitter', 'archiver', 'websrv'];

	// Launch child processes
	try {
		const procs = yield Promise.all(to_launch.map((user) => {
			const childname = `@${user.screen_name}`;
			const addtoenv = {
				childname,
				user_id_str: user.id_str,
				user_db_path: user.db_path,
				consumer_key: mdb.config.app.consumer_key,
				consumer_secret: mdb.config.app.consumer_secret,
				access_token_key: user.token_key,
				access_token_secret: user.token_secret,
				app_name: mdb.config.app.name,
				app_version: pkg.version,
			};

			return mdb.user_activate(user.id_str)
			.then(() => mgr.launch('./proc/twitter.js', childname, { addtoenv }))
			.then((proc) => {
				proc.user_id_str = user.id_str;
				return proc;
			});
		}));
		mgr.log('All processes started');

		try {
			yield mgr.sendall('ready');
			mgr.log('Sent ready signal');
		}
		catch(e) {
			mgr.err(e);
		}
	}
	catch (err) {
		mgr.err('One or more processes could not be started; exiting...');
		yield mgr.shutdown();
	}

	// Kick back, relax?
})())
.catch(errcb);
