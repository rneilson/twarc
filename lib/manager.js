'use strict';

const EventEmitter = require('events');
const child_process = require('child_process');

// Default options
const defaults = {
	autokill: true,		// Automatically terminate children when master exits
	waitformsg: false,	// Wait for first message from child before considering launched
	starttime: 10000,	// Timeout for above
	waitforexit: false,	// Wait for exit event from child before considering shutdown
	exittime: 10000,	// Timeout for above
	relaunch: false,	// Relaunch child on unexpected exit
	forkopts: null,		// Additional options to fork()
	addtoenv: null,		// Values to add to child environment (supercedes forkopts.env)
};

// Process checker
function checkproc (mgr, proc) {
	return typeof proc === 'object' && proc.hasOwnProperty('name') && mgr.children.hasOwnProperty(proc.name);
}

// Process forker
function startproc (procfile, procname, procopts, procargs) {
	// Launch process
	var child = child_process.fork(procfile, procargs, procopts.forkopts);
	// Name process (defaults to file name)
	child.name = procname || procfile;
	// Store launch options
	child.options = procopts;
	return child;
}

class Manager extends EventEmitter {

	constructor (options, logger) {
		super();
		this.options = Object.assign({}, defaults, options);
		// Tracked child processes
		this.children = {};
		// Logger
		this.log = logger || console.log.bind(console);
		// Add exit listener for main process
		if (this.options.autokill) {
			process.once('exit', code => {
				this.shutdown();
			});
		}
	}

	// Handler for child message recipt
	// TODO: emit child process name instead, or leave with whole object?
	recvmsg (proc, msg, handle) {
		// Emit heartbeat
		if (msg === 'heartbeat') {
			// TODO: add heartbeat tracking per-child
			this.emit('heartbeat', proc, new Date(), handle);
		}
		// Emit message as event if string
		// (Equivalent to {type: msg} with no payload)
		else if (typeof msg === 'string') {
			this.emit(msg, proc, undefined, handle);
		}
		// Emit typed message if available
		else if (msg !== null && typeof msg === 'object' && msg.type) {
			this.emit(msg.type, proc, msg.data, handle);
		}
		// Emit generic message event otherwise
		else {
			this.emit('message', proc, msg, handle);
		}
	}

	sendmsg (proc, msg, ...args) {
		// Get process if only given name
		if (typeof proc === 'string') {
			proc = this.children[proc];
		}
		// Sanity check
		if (!checkproc(this, proc)) {
			throw new Error(`Can't send message to invalid process '${proc}'`);
		}
		// Promisify and return
		return new Promise((resolve, reject) => {
			// Add callback to args
			let sendargs = args.concat(err => {
				if (err === null) {
					resolve(true);
				}
				else {
					reject(err);
				}
			});
			proc.send(msg, ...sendargs);
		});
	}

	launch (procfile, ...args) {
		// Startup function
		let started = proc => {
			// Add child to managed list
			let procpid = proc.pid;
			let procname = proc.name;
			this.children[procname] = proc;

			// Add unexpected exit handler
			let exitfn = (code, signal, launchfile, ...launchargs) => {
				this.log(`Child process '${procname}' exited with ${(code !== null) ? 'code: ' + code : 'signal: ' + signal}`);

				// Remove child from manager
				delete this.children[procname];

				// Emit exit event
				this.emit(`exit:${procname}`, proc);

				// Relaunch check
				if (launchfile) {
					this.launch(launchfile, ...launchargs);
				}

				// TODO: anything else?
			};
			// Use slightly different function if relaunching
			if (proc.options.relaunch) {
				// Only capture procfile & args in closure if we're relaunching
				proc.exitfn = (code, signal) => {
					exitfn(code, signal, procfile, ...args);
				}
			}
			else {
				proc.exitfn = exitfn;
			}
			proc.once('exit', proc.exitfn)

			// Add message handler
			let msgfn = (msg, handle) => {
				this.recvmsg(proc, msg, handle);
			};
			proc.msgfn = msgfn;
			proc.on('message', msgfn);

			// Log startup
			this.log(`Started: '${procname}', PID: ${procpid}`);

			// Emit started event
			this.emit(`start:${procname}`, proc);
		}

		// Options to use
		var useopts = Object.assign({}, this.options);
		// Child args to use
		var useargs = [];
		// Process name (defaults to file/module)
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
			else if (opt !== null && typeof opt === 'object') {
				useopts = Object.assign(useopts, opt);
			}
			// TODO: add function check for callbacks?
		}

		// Name check (don't overwrite existing process)
		if (this.children.hasOwnProperty(usename)) {
			throw new Error(`Error starting process '${usename}': already exists`);
		}

		// Process environment values
		var env = Object.assign({}, useopts.forkopts ? useopts.forkopts.env :  process.env);
		// Add extra environment values if given
		if (typeof useopts.addtoenv === 'object'){
			env = Object.assign(env, useopts.addtoenv)
		}
		// Update fork options
		if (useopts.forkopts !== null && typeof useopts.forkopts === 'object') {
			useopts.forkopts.env = env;
		}
		else {
			useopts.forkopts = { env: env };
		}

		// Return promise
		var promise;
		if (useopts.waitformsg) {
			promise = new Promise((resolve, reject) => {
				// Schedule for next tick
				process.nextTick(() => {
					// Log startup
					this.log(`Starting: '${usename}'`);

					let child;
					try {
						child = startproc(procfile, usename, useopts, useargs);
					} catch (e) {
						reject(e);
					}

					let errfn = err => {
						reject(new Error(`Error starting process '${child.name}': ${err}`));
					};

					// Reject promise if timeout expires before first message
					if (useopts.starttime > 0) {
						setTimeout(() => {
							reject(new Error(`Timed out waiting for process '${child.name}' to send first message`));
						}, useopts.starttime);
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
			});
		}
		else {
			// promise = Promise.resolve([child]);
			promise = new Promise((resolve, reject) => {
				// Schedule for next tick
				process.nextTick(() => {
					let child;
					try {
						child = startproc(procfile, usename, useopts, useargs);
					} catch (e) {
						reject(e);
					}
					resolve([child]);
				});
			});
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
		if (proc !== undefined) {
			// Get process if only given name
			if (typeof proc === 'string') {
				proc = this.children[proc];
			}

			return new Promise((resolve, reject) => {
				// Sanity check
				if (!checkproc(this, proc)) {
					throw new Error(`Can't shutdown unknown or invalid process: '${proc.name || proc}'`);
				}

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
				this.emit(`exit:${child.name}`, child);

				return child;
			});
		}
		// Call recursively on each child process, return array of shutdown promises
		// Note: does NOT return Promise.all(), since that might reject with only one
		// error, and thus lose information on the rest of the processes (if the end
		// user wants to go that route, they're welcome to...)
		else {
			let ret = [];
			for (let name of Object.keys(this.children)) {
				let proc = this.children[name];
				if (proc !== undefined) {
					ret.push(this.shutdown(proc));
				}
			}
			return ret;
		}
	}
}

module.exports = Manager;
