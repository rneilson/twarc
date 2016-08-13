'use strict';

const EventEmitter = require('events');
const child_process = require('child_process');

// Default options
const defaults = {
	waitformsg: false,	// Wait for first message from child before considering launched
	starttime: 10000,	// Timeout for above
	waitforexit: false,	// Wait for exit event from child before considering shutdown
	exittime: 10000,	// Timeout for above
	relaunch: false,	// Relaunch child on unexpected exit
	forkopts: null,		// Additional options to fork()
	addtoenv: null,		// Values to add to child environment (supercedes forkopts.env)
};

// Process checker
function checkproc (proc) {
	return Object.prototype.hasOwnProperty(proc, 'name') && Object.prototype.hasOwnProperty(this.children, proc.name);
}

class Manager extends EventEmitter {

	constructor (options) {
		super();
		this.options = Object.assign({}, defaults, options);
		// Tracked child processes
		this.children = {};
		// Logger
		this.log = this.options.log || console.log.bind(console);
		// TODO: add SIGTERM listener here, or leave to calling code?
	}

	// Handler for child message recipt
	// TODO: emit child process name instead, or leave with whole object?
	recvmsg (proc, msg, handle) {
		// Emit heartbeat
		if (msg === 'heartbeat') {
			// TODO: add heartbeat tracking per-child
			this.emit('heartbeat', proc, handle);
		}
		// Emit raw message if string
		else if (typeof msg === 'string') {
			this.emit('message', proc, msg, handle);
		}
		// Emit typed message if available
		else if (msg && msg.type && msg.data) {
			this.emit(msg.type, proc, msg.data, handle);
		}
	}

	sendmsg (proc, msg, handle) {
		// Get process if only given name
		if (typeof proc === 'string') {
			proc = this.children[proc];
		}
		// Sanity check
		if (!checkproc(proc)) {
			throw new Error(`Can't send message to invalid process '${proc}'`);
		}
		proc.send(msg, handle);
	}

	launch (procfile, ...args) {
		// Startup function
		let started = proc => {
			// Add child to managed list
			this.children[proc.name] = proc;

			// Log startup
			this.log(`Started: '${proc.name}'...`);

			// Add unexpected exit handler
			let exitfn = (code, signal) => {
				this.log(`Child process '${proc.name}' exited unexpectedly with ${
					(code !== null) ? 'code: ' + code : 'signal: ' + signal}`);
				// TODO: add relaunch check
				// TODO: anything else?
			};
			proc.exitfn = exitfn;
			proc.once('exit', exitfn);

			// Add message handler
			let msgfn = (msg, handle) => {
				this.recvmsg(proc, msg, handle);
			};
			proc.msgfn = msgfn;
			proc.on('message', msgfn);

			// Emit started event
			this.emit('start', proc);
		}

		// Options to use
		var opts = Object.assign({}, this.options);
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
			// Array args will extend supplied args (no dup check)
			else if (Array.isArray(opt)) {
				useargs = useargs.concat(opt);
			}
			// Object args will overwrite defaults
			else if (typeof opt === 'object') {
				opts = Object.assign(opts, opt);
			}
			// TODO: add function check for callbacks?
		}

		// Process environment values
		var env = Object.assign({}, opts.forkopts.env || process.env);
		// Add extra environment values if given
		if (typeof opts.addtoenv === 'object'){
			env = Object.assign(env, opts.addtoenv)
		}
		// Update fork options
		if (typeof opts.forkopts === 'object') {
			opts.forkopts.env = env;
		}
		else {
			opts.forkopts = { env: env };
		}

		// Launch process
		var child = child_process.fork(procfile, useargs, opts.forkopts);

		// Name process
		child.name = usename;
		// Store launch options
		child.options = opts;

		// Return promise
		var promise;
		if (opts.waitformsg) {
			promise = new Promise((resolve, reject) => {
				let errfn = err => {
					reject(new Error(`Error while starting process '${child.name}': ${err}`));
				};

				// Reject promise if timeout expires before first message
				if (opts.starttime > 0) {
					setTimeout(() => {
						reject(new Error(`Timed out waiting for process '${child.name}' to send first message`));
					}, opts.starttime);
				}

				// Reject promise if error occurs during spawn
				child.once('error', errfn);

				// Resolve promise once child sends first message
				child.once('message', (msg, handle) => {
					// Remove error handler
					child.removeListener('error', errfn);

					// Resolve promise
					resolve([child, msg, handle]);
				});
			});
		}
		else {
			promise = Promise.resolve([child]);
		}

		return promise.then(([proc, initmsg, inithand]) => {
			// Initial startup
			started(proc);

			// Deal with initial message if rec'd
			if (initmsg) {
				this.recvmsg(proc, initmsg, inithand);
			}

			return proc;
		});
	}

	shutdown (proc) {
		// Shut down specific process
		if (proc) {
			// Get process if only given name
			if (typeof proc === 'string') {
				proc = this.children[proc];
			}

			// Sanity check
			if (!checkproc(proc)) {
				throw new Error(`Can't shutdown invalid process: '${proc.name || proc}'`);
			}
			
			return new Promise(function (resolve, reject) {
				// Remove unexpected-exit handler
				proc.removeListener('exit', proc.exitfn);
				delete proc.exitfn;

				// Remove message handler
				proc.removeListener('message', proc.msgfn);
				delete proc.msgfn;

				// Add exit waiter
				if (proc.options.waitforexit) {
					let errfn = err => {
						reject(new Error(`Error while shutting down process '${proc.name}': ${err}`));
					};

					// Reject promise if timeout expires before first message
					if (proc.options.starttime > 0) {
						setTimeout(() => {
							reject(new Error(`Timed out waiting for process '${proc.name}' to shut down`));
						}, proc.options.starttime);
					}

					// Reject promise if error occurs during spawn
					proc.once('error', errfn);

					// Resolve promise once child sends exit event
					proc.once('exit', (code, signal) => {
						// Remove error handler
						proc.removeListener('error', errfn);

						// Resolve promise
						resolve([proc, code, signal]);
					});
				}

				// Log stoppage attempt
				this.log(`Stopping: '${proc.name}', PID: ${proc.pid}`);

				// Send signal
				proc.kill('SIGTERM');

				// Resolve immediately if not waiting
				if (!proc.options.waitforexit) {
					resolve([proc, null, null]);
				}

			}).then(([child, code, signal]) => {
				// Log successful shutdown
				if (code !== null || signal !== null) {
					this.log(`Stopped: '${proc.name}', exited with: ${(code !== null) ? 'code: ' + code : 'signal: ' + signal}`);
				}

				// Remove child from manager
				delete this.children[child.name];

				// Emit exit event
				this.emit('exit', child);

				return child;
			});
		}
		// Call recursively on each child process, return object of shutdown promises
		// Note: does NOT return Promise.all(), since that might reject with only one
		// error, and thus lose information on the rest of the processes; if the end
		// user wants to go that route, they're welcome to...
		else {
			let ret = {};
			for (let name of Object.keys(this.children)) {
				ret[name] = this.shutdown(this.children[name]);
			}
			return ret;
		}
	}
}

module.exports = Manager;
