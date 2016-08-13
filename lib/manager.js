'use strict';

const EventEmitter = require('events');
const child_process = require('child_process');

// Default options
const defaultopts = {
	waitformsg: false,
	relaunch: false,
	forkopts: null,
	addtoenv: null,
};

class Manager extends EventEmitter {

	constructor (defaults) {
		super();
		this.defaults = Object.assign({}, defaultopts, defaults);
		// Tracked child processes
		this.children = {};
		this.exitfns = {};
		// Logger
		this.log = this.defaults.log || console.log.bind(console);
	}

	launch (procfile, ...args) {
		// Options to use
		var useopts = Object.assign({}, this.defaults);
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
			// TODO: add function check for callbacks?
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

		// Name process
		child.name = usename;

		// Return promise
		var promise;
		if (useopts.waitformsg) {
			promise = new Promise((resolve, reject) => {
				let errfn = (err => {
					reject(err);
				});
				// Reject promise if error occurs during spawn
				child.once('error', errfn);
				// Resolve promise once child sends first message
				child.once('message', () => {
					// Remove error handler
					child.removeListener('error', errfn);
					resolve(child);
				});
			});
		}
		else {
			promise = Promise.resolve(child);
		}
		return promise.then(proc => {
			// Log startup
			this.log(`Starting: '${proc.name}'...`);
			// Add to managed list
			this.children[proc.name] = proc;
			// Add message handler
			proc.on('message', msg => {
				// Emit heartbeat
				if (msg === 'heartbeat') {
					this.emit('heartbeat', proc.name);
				}
				// Emit raw message if string
				else if (typeof msg === 'string') {
					this.emit('message', proc.name, msg);
				}
				// Emit typed message if available
				else if (msg && msg.type && msg.data) {
					this.emit(msg.type, proc.name, msg.data);
				}
			});
			// TODO: add log handler
			// Add exit handler
			let exitfn = ((code, signal) => {
				this.log(`Child process '${proc.name}' exited with ${(code !== null) ? 'code: ' + code : 'signal: ' + signal}`);
				// TODO: add relaunch check
				// TODO: anything else?
			});
			proc.once('exit', exitfn);
			// Add process exit cleanup function to tracker
			this.exitfn[proc.name] = exitfn;
		});
	}

	shutdown (proc) {
		// Shut down specific process
		if (proc) {
			// Sanity check
			if (!Object.prototype.hasOwnPropery(proc, 'name') || !Object.prototype.hasOwnPropery(this.children, proc.name)) {
				throw new Error(`Can't shutdown invalid child process: ${proc.name || proc}`);
			}
			// Remove exit handler
			proc.removeListener('exit', this.exitfn[proc.name]);
			delete this.exitfn[proc.name];
			// Log stoppage
			this.log(`Stopping: '${proc.name}', PID: ${proc.pid}`);
			// Send signal
			proc.kill('SIGTERM');
		}
		// Call recursively on each child process
		else {
			for (let name of Object.keys(this.children)) {
				this.shutdown(this.children[name]);
			}
		}
	}
}

module.exports = Manager;
